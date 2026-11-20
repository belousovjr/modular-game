declare module 'javascript-astar' {
  interface GridNode { readonly x:number; readonly y:number }
  class Graph {
    constructor(weights:number[][]);
    readonly grid:GridNode[][];
    neighbors(node:GridNode):GridNode[];
    markDirty(node:GridNode):void;
  }
  const pathfinding:{
    Graph:typeof Graph;
    astar:{search(graph:Graph,start:GridNode,goal:GridNode):GridNode[]};
  };
  export default pathfinding;
}
