// Map RGB is supplied by the model. Preserve it while removing unintended partial alpha.
// Fully transparent pixels remain detectable as missing output, rather than becoming black.
export function opaqueTerrainPixels(data) {
  let changed=0;
  for(let i=3;i<data.length;i+=4)if(data[i]>0&&data[i]<255){data[i]=255;changed++;}
  return changed;
}
