/*
 *  preferences.ts is a part of Moosync.
 *
 *  Copyright 2021-2022 by Sahil Gupte <sahilsachingupte@gmail.com>. All rights reserved.
 *  Licensed under the GNU General Public License.
 *
 *  See LICENSE in the project root for license information.
 */

import Store from 'electron-store'
import { app } from 'electron'
import { enableStartup } from '../autoLaunch'
import path from 'path'
import { getExtensionHostChannel, getPreferenceChannel, getScannerChannel } from '../ipc'
import { setMinimizeToTray } from '@/utils/main/windowManager'
import { watch } from 'fs/promises'
import { setLogLevel } from '../logger/utils'
import log from 'loglevel'
import { isEmpty } from '@/utils/common'
import { defaultKeybinds } from '@/utils/commonConstants'

type MusicPaths = { path: string; enabled: boolean }

const defaultPreferences: Preferences = {
  isFirstLaunch: true,
  musicPaths: [{ path: getDefaultMusicPaths(), enabled: true }],
  thumbnailPath: path.join(app.getPath('appData'), app.getName(), '.thumbnails'),
  artworkPath: path.join(app.getPath('appData'), app.getName(), '.thumbnails'),
  youtubeAlt: [],
  youtubeOptions: [],
  invidious: [],
  system: [],
  audio: [],
  zoomFactor: '100',
  themes: {},
  activeTheme: 'default',
  hotkeys: defaultKeybinds,
  logs: []
}

let ac: AbortController

export const store = new Store({
  defaults: { prefs: defaultPreferences },
  serialize: (value) => JSON.stringify(value)
})

const preferenceListenKeys: { key: string; isMainWindow: boolean; channel: string }[] = []

/**
 * Saves preferences
 * All preferences are stored under a key "prefs"
 * @param prefs preferences to be stored
 */
export function savePreferences(prefs: Preferences) {
  store.set('prefs', prefs)
}

/**
 * Sets last used window size
 * @param windowName name of window whose size is to be set
 * @param windowSize size of window. Dictionary with width and height keys containing width and height of that window
 */
export function setWindowSize(windowName: string, windowSize: { width: number; height: number }) {
  store.set(`window.${windowName}`, windowSize)
}

/**
 * Gets window size
 * @param windowName name of window whose size is to be fetched
 * @param defaultValue default size in width and height
 * @returns
 */
export function getWindowSize(windowName: string, defaultValue: { width: number; height: number }) {
  return store.get(`window.${windowName}`, defaultValue)
}

/**
 * Saves a single key inside "prefs". Deep keys can be accessed by "." separator.
 * @param key
 * @param value
 * @param [isExtension] true if preference is of an extension. false otherwise
 */
export function saveSelectivePreference(key: string, value: unknown, isExtension = false, notify = false) {
  if (typeof value !== 'undefined' && value !== null) {
    store.set(`prefs.${isExtension ? 'extension.' : ''}${key}`, value)
  } else {
    store.delete(`prefs.${isExtension ? 'extension.' : ''}${key}` as unknown as 'prefs')
  }

  const listenKey = preferenceListenKeys.find((val) => val.key === key)
  if (listenKey) {
    getPreferenceChannel().notifyWindow(listenKey.key, value, listenKey.isMainWindow, listenKey.channel)
  }
}

/**
 * Loads selective preference inside "prefs"
 * @template T expected object which will be returned
 * @param [key]
 * @param [isExtension] true if preference is of an extension. false otherwise
 * @param [defaultValue]
 * @returns object belonging to given key
 */
export function loadSelectivePreference<T>(key?: string, isExtension = false, defaultValue?: T): T | undefined {
  try {
    const pref = store.get(`prefs.${isExtension ? 'extension.' : ''}${key}`, defaultValue)
    return pref
  } catch (e) {
    console.error(e)
  }
  return defaultValue
}

export function loadSelectiveArrayPreference<T>(key: string, defaultValue?: T): T | undefined {
  try {
    const parentKey = key.substring(0, key.lastIndexOf('.'))
    const childKey = key.substring(key.lastIndexOf('.') + 1)
    const pref: { key: string }[] = store.get(`prefs.${parentKey}`)
    if (pref) {
      return pref.find((val) => val.key === childKey) as T
    }
  } catch (e) {
    console.error(e)
  }
  return defaultValue
}

/**
 * Removes selective preference inside "prefs"
 * @param key key to remove inside prefs
 */
export function removeSelectivePreference(key: string, isExtension = false) {
  store.delete(`prefs.${isExtension ? 'extension.' : ''}${key}` as never)
}

/**
 * Sets initial interface settings
 */
export function setInitialPreferences() {
  onPreferenceChanged('system', loadPreferences()?.system)
  saveSelectivePreference('logs.0', {
    key: 'debug_logging',
    title: 'Enable debug logging',
    enabled: process.env.DEBUG_LOGGING
  })
}

/**
 * Should be called when preferences are changed
 * @param key
 * @param value
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function onPreferenceChanged(key: string, value: any) {
  if (key === 'system' && value) {
    for (const val of value) {
      if (val.key === 'startOnStartup') {
        val.enabled !== undefined && enableStartup(val.enabled)
      }

      if (val.key === 'minimizeToTray') {
        val.enabled !== undefined && setMinimizeToTray(val.enabled)
      }

      if (val.key === 'watchFileChanges') {
        if (!val.enabled && ac) {
          ac.abort()
        }
      }
    }
    return
  }

  if (key === 'musicPaths') {
    getScannerChannel().scanAll()
    shouldWatchFileChanges()
    return
  }

  if (key === 'logs') {
    for (const l of value as Checkbox[]) {
      if (l.key === 'debug_logging') {
        const level = l.enabled ? log.levels.TRACE : log.levels.INFO
        setLogLevel(level)
        getExtensionHostChannel().setLogLevel(level)
      }
    }
  }
}

// TODO: Scan only changed file
export function shouldWatchFileChanges() {
  const value = loadSelectivePreference<MusicPaths[]>('musicPaths')
  if (value) {
    if (ac) ac.abort()

    const watchChanges =
      loadSelectivePreference<SystemSettings[]>('system', false, [])?.find((val) => val.key === 'watchFileChanges')
        ?.enabled ?? false
    if (watchChanges) {
      setupScanWatcher(value)
    }
  }
}

export function setupScanWatcher(dirs: MusicPaths[]) {
  console.debug('Setting up scan watcher')
  ac = new AbortController()
  const { signal } = ac
  for (const d of dirs) {
    if (d.enabled) {
      console.debug('Watching', d.path, 'for changes')
      ;(async () => {
        const watcher = watch(d.path, { signal })
        try {
          for await (const _ of watcher) {
            console.debug('Got changes in', d.path, 'triggering scan')
            getScannerChannel().scanAll()
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') return
          console.error(e)
        }
      })()
    }
  }
}

/**
 * Validates preferences
 * @param prefs to be validated
 * @returns corrected prefs
 */
function validatePrefs(prefs: Preferences): Preferences {
  if (prefs) {
    for (const [key, value] of Object.entries(defaultPreferences)) {
      if (isEmpty(prefs[key as keyof Preferences])) {
        prefs[key as keyof Preferences] = value as never
      }
    }

    return prefs
  }

  return defaultPreferences
}

/**
 * Loads all preferences
 * @returns preferences
 */
export function loadPreferences(): Preferences {
  try {
    const tmp = store.get('prefs') as Preferences
    if (tmp) {
      const validated = validatePrefs(tmp)
      store.set('prefs', validated)
      return validated
    }
  } catch (e) {
    console.error(e)
  }
  return defaultPreferences
}

// TODO: Make a generic utils file for methods like these
/**
 * Gets disabled paths from a list of paths
 * @param paths
 * @returns disabled paths
 */
export function getDisabledPaths(paths: togglePaths): string[] {
  const disablePaths = []
  for (const p of paths) {
    if (!p.enabled) disablePaths.push(p.path)
  }
  return disablePaths
}

function getDefaultMusicPaths() {
  return app.getPath('music')
}

export function setPreferenceListenKey(key: string, isMainWindow = false) {
  const channel = `${key}:mainWindow:${isMainWindow}`
  preferenceListenKeys.push({ key, isMainWindow, channel })
  return channel
}

export function resetPrefsToDefault() {
  const prefs = loadPreferences()
  for (const [key, value] of Object.entries(defaultPreferences)) {
    prefs[key as keyof Preferences] = value as never
  }

  prefs.isFirstLaunch = false

  savePreferences(prefs)
  setInitialPreferences()
}
