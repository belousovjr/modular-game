import sharp from 'sharp';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';
const source=process.argv[2];if(!source)throw Error('Usage: node scripts/prepare-atmosphere.mjs <directory with moon.jpg>');
const out='public/textures/atmosphere';await mkdir(out,{recursive:true});
await sharp(source+'/moon.jpg').resize(512,256).webp({quality:88}).toFile(out+'/moon.webp');
const manifest={moon:{url:'http://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg',credit:'NASA / GSFC / Arizona State University, LRO LROC, CGI Moon Kit; public domain'},files:{}};
for(const file of ['moon.webp']){const bytes=await readFile(out+'/'+file);manifest.files[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}await writeFile(out+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log(manifest.files);
