export function pendingTiles(project,pending,display='processed') {
  if(!pending)return project.tiles;
  if(pending.finalTiles)return pending.finalTiles;
  if(pending.tiles)return project.tiles.map(t=>pending.tiles.find(v=>v.id===t.id)||t);
  const tile=display==='raw'?{...pending.tile,originalId:pending.tile.candidateAssetId||pending.tile.originalId}:pending.tile;
  return [...project.tiles.map(t=>(display==='processed'&&pending.tile.stitchUpdates?.find(u=>u.id===t.id))||(pending.mode==='replace'&&t.id===tile.id?tile:t)),...(pending.mode==='add'?[tile]:[])];
}
