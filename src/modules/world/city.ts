import data from './data/downtown/city.json' with {type:'json'};
import type {CitySource} from '../world-generation/index.ts';

export const citySource:CitySource={...data,placements:data.placements.map(p=>{const parameters:Record<string,number>={};for(const [key,value] of Object.entries(p.parameters))if(typeof value==='number')parameters[key]=value;return {...p,parameters,position:[p.position[0],p.position[1],p.position[2]],rotation:[p.rotation[0],p.rotation[1],p.rotation[2]]};})};
