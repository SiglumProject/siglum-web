import {runLocalBiber} from './biber-adapter.mjs';
export function runBiber(job,context){return runLocalBiber(job.input,context.readProjectFile,context.signal)}
