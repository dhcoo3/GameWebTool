// Include adjacent accepted pixels in the SAME editing frame as the new region.
// Extra style/context images have no coordinate contract and cannot replace this anchor.
export function gptExpansionFrame(target, neighbors) {
  const reach = Math.round(Math.min(target.width, target.height) * .5);
  let left=target.x, top=target.y, right=left+target.width, bottom=top+target.height;
  for (const r of neighbors) {
    if (r.x > target.x+target.width || r.x+r.width < target.x || r.y > target.y+target.height || r.y+r.height < target.y) continue;
    if (r.y < target.y+target.height && r.y+r.height > target.y) {
      if(r.x<target.x) left=Math.min(left,Math.max(r.x,target.x-reach));
      if(r.x+r.width>target.x+target.width) right=Math.max(right,Math.min(r.x+r.width,target.x+target.width+reach));
    }
    if (r.x < target.x+target.width && r.x+r.width > target.x) {
      if(r.y<target.y) top=Math.min(top,Math.max(r.y,target.y-reach));
      if(r.y+r.height>target.y+target.height) bottom=Math.max(bottom,Math.min(r.y+r.height,target.y+target.height+reach));
    }
  }
  return { x:left, y:top, width:right-left, height:bottom-top };
}
