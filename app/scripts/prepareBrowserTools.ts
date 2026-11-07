import {fileURLToPath} from 'node:url'
import {prepareBrowserTools} from './browserTools'
prepareBrowserTools(fileURLToPath(new URL('..',import.meta.url)))
