// Historical schedule fixture: keep summer-specific crew and timetable regression cases
// independent of the currently deployed GTFS. Current-feed coverage lives in gtfs-refresh.test.js.
import { gunzipSync } from 'node:zlib';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
export const summerRoot = await mkdtemp(path.join(tmpdir(), 'did-summer-2026-'));
const files = JSON.parse(gunzipSync(await readFile(new URL('./summer-2026.json.gz', import.meta.url))));
for (const [name, data] of Object.entries(files)) {
 await mkdir(path.dirname(path.join(summerRoot, name)), { recursive: true });
 await writeFile(path.join(summerRoot, name), data);
}
after(() => rm(summerRoot, { recursive: true, force: true }));
