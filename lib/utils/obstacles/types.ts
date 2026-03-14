export type Obstacle = {
  type: "rect" | "oval"
  layers: string[]
  center: { x: number; y: number }
  width: number
  height: number
  connectedTo: string[]
  netIsAssignable?: boolean
  offBoardConnectsTo?: string[]
}
