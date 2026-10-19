// Cold EEPROM checkpoints for the pinned SITL POSIX storage backend (16 KiB).
// IndexedDB transactions atomically replace one validated profile revision.
export const EEPROM_BYTES=16384;
export interface EepromCheckpoint {
  schemaVersion:1; identity:string; revision:number; sha256:string; image:Uint8Array<ArrayBuffer>;
}
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
export function storageIdentity(commit:string,moduleSha256:string,profile:string):string {
  if(!/^[a-f0-9]{40}$/.test(commit)||!/^[a-f0-9]{64}$/.test(moduleSha256)||!/^[a-zA-Z0-9_-]{1,64}$/.test(profile))throw Error('Invalid firmware storage identity');
  return `${commit}:${moduleSha256}:${profile}`;
}
async function digest(image:Uint8Array<ArrayBuffer>):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',image)),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function createCheckpoint(identity:string,revision:number,bytes:Uint8Array):Promise<EepromCheckpoint> {
  if(bytes.length!==EEPROM_BYTES)throw Error('Invalid EEPROM size');
  if(!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid EEPROM revision');
  const image=new Uint8Array(bytes);
  return {schemaVersion:1,identity,revision,sha256:await digest(image),image};
}
export async function validateCheckpoint(value:unknown,identity:string):Promise<EepromCheckpoint> {
  if(!record(value)||value.schemaVersion!==1||value.identity!==identity)throw Error('EEPROM checkpoint identity/schema mismatch');
  if(!Number.isSafeInteger(value.revision)||typeof value.revision!=='number'||value.revision<1||
    !(value.image instanceof Uint8Array)||value.image.length!==EEPROM_BYTES||!(value.image.buffer instanceof ArrayBuffer)||
    typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))throw Error('Invalid EEPROM checkpoint');
  const checkpoint=await createCheckpoint(identity,value.revision,value.image);
  if(checkpoint.sha256!==value.sha256)throw Error('EEPROM checkpoint checksum mismatch');
  return checkpoint;
}
export class EepromStore {
  private readonly database:IDBDatabase;
  private readonly identity:string;
  private constructor(database:IDBDatabase,identity:string){this.database=database;this.identity=identity;}
  static async open(identity:string):Promise<EepromStore> {
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open('mirage-ardupilot-eeprom-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('profiles');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('EEPROM database open failed'));
      request.onblocked=()=>reject(Error('EEPROM database upgrade blocked'));
    });
    return new EepromStore(database,identity);
  }
  async load():Promise<EepromCheckpoint|null> {
    const raw:unknown=await new Promise((resolve,reject)=>{
      const tx=this.database.transaction('profiles','readonly'),request=tx.objectStore('profiles').get(this.identity);
      request.onsuccess=()=>{const value:unknown=request.result;resolve(value);};
      request.onerror=()=>reject(Error('EEPROM checkpoint read failed'));
    });
    return raw===undefined?null:validateCheckpoint(raw,this.identity);
  }
  async commit(bytes:Uint8Array,expectedRevision:number):Promise<EepromCheckpoint> {
    const previous=await this.load();
    if((previous?.revision??0)!==expectedRevision)throw Error('EEPROM checkpoint revision conflict');
    const checkpoint=await createCheckpoint(this.identity,expectedRevision+1,bytes);
    await new Promise<void>((resolve,reject)=>{
      const tx=this.database.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),request=store.get(this.identity);
      let conflict=false;
      request.onsuccess=()=>{
        const current:unknown=request.result;
        const revision=current===undefined?0:record(current)&&typeof current.revision==='number'?current.revision:-1;
        if(revision!==expectedRevision){conflict=true;tx.abort();return;}
        store.put(checkpoint,this.identity);
      };
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(Error(conflict?'EEPROM checkpoint revision conflict':'EEPROM checkpoint transaction aborted'));
      tx.onerror=()=>reject(Error('EEPROM checkpoint transaction failed'));
    });
    return checkpoint;
  }
  close():void{this.database.close();}
}
