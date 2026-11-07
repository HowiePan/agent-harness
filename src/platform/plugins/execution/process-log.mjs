import { openSync, writeSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { assertNoLinkPath } from '../../../common/paths.mjs';

// Synchronous chunk writes provide backpressure without retaining queued output.
export const createProcessLog = async (root, maxBytes) => {
  const directory=resolve(root,'logs',randomUUID());
  assertNoLinkPath(root,directory);
  await mkdir(directory,{recursive:true});
  const streams=Object.fromEntries(['stdout','stderr'].map(name=>{
    const path=resolve(directory,`${name}.log`);
    return [name,{path,fd:openSync(path,'wx'),bytes:0,hash:createHash('sha256')}];
  }));
  let bytes=0,closed=false,exceeded=false;
  return {
    write(name,chunk) {
      const stream=streams[name],part=chunk.subarray(0,Math.max(0,maxBytes-bytes));
      let offset=0;while(offset<part.length)offset+=writeSync(stream.fd,part,offset,part.length-offset);
      stream.hash.update(part);stream.bytes+=part.length;bytes+=part.length;
      exceeded ||= part.length!==chunk.length;
      return !exceeded;
    },
    finish() {
      if(closed) throw Error('Process log already sealed');
      closed=true;
      return {complete:!exceeded,totalBytes:bytes,maxBytes,streams:Object.fromEntries(Object.entries(streams).map(([name,s])=>{
        closeSync(s.fd);return [name,{path:s.path,bytes:s.bytes,sha256:s.hash.digest('hex')}];
      }))};
    }
  };
};
