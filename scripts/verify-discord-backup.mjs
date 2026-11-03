import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {openBackup} from './discord-backup.mjs';
try{
 const manifestPath=process.argv[2];if(!manifestPath)throw Error('Usage: BACKUP_ENCRYPTION_KEY=... node scripts/verify-discord-backup.mjs /path/to/manifest.json [--output /private/path/recovered.json]');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));if(!Array.isArray(manifest.parts)||manifest.parts.some(p=>!/^cid-[0-9TZ]+-[a-f0-9]+\.cidbackup\.part\d{4,}$/.test(p.name)))throw Error('Invalid backup filenames.');
 const parts=await Promise.all(manifest.parts.map(part=>readFile(resolve(dirname(manifestPath),part.name))));const snapshot=openBackup(manifest,parts,process.env.BACKUP_ENCRYPTION_KEY);
 if(process.argv[3]){if(process.argv[3]!=='--output'||!process.argv[4])throw Error('Expected --output /private/path/recovered.json');await writeFile(process.argv[4],JSON.stringify(snapshot,null,2),{mode:0o600,flag:'wx'});}
 console.log(JSON.stringify({verified:true,project:snapshot.project,readTime:snapshot.readTime,documentCount:snapshot.documents.length,counts:snapshot.counts,exported:!!process.argv[4]}));
}catch(error){console.error(error.code?'Could not read or create backup files: '+error.code:error.message);process.exitCode=1;}
