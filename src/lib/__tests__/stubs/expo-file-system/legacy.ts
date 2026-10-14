// Stand-in for expo-file-system/legacy in the Node harnesses that bundle the
// photo and video queues only to ask which jobs they still hold
// (scripts/test-cache-prune.mjs, scripts/test-offline-day-pack.mjs alias the
// package to this folder). Nothing here touches a file.
export const documentDirectory = 'file:///harness/'
export async function getInfoAsync() { return { exists: false } }
export async function makeDirectoryAsync() {}
export async function copyAsync() {}
export async function deleteAsync() {}
export async function readAsStringAsync() { return '' }
export const EncodingType = { Base64: 'base64', UTF8: 'utf8' }
