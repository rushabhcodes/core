import { fanoutTracePath } from "@tscircuit/props"
import type { PcbPort } from "circuit-json"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
  SingleLayerConnectionPoint,
} from "lib/utils/autorouting/SimpleRouteJson"
import { applyToPoint, inverse } from "transformation-matrix"
import type { z } from "zod"
import type { Port } from "../Port"
import type { IGroup } from "./IGroup"
import type { ISubcircuit } from "./Subcircuit/ISubcircuit"
import { getSavedAutoroutingPhaseTracesFromPaths } from "./get-saved-autorouting-phase-traces"
import { getSavedPcbTracePathTransform } from "./get-saved-pcb-trace-path-transform"

export type AutoroutingPhasePcbTracePaths = {
  pcbTracePaths?: z.output<typeof fanoutTracePath>[]
  pcbTracePathsUnavailableReason?: string
}

type PcbPortId = PcbPort["pcb_port_id"]
type WireOrVia = Extract<SimplifiedPcbTrace["route"][number], { x: number }>

type RoutedEdge = {
  route: WireOrVia[]
  start: string
  end: string
}

const touches = (
  point: WireOrVia,
  terminal: SingleLayerConnectionPoint,
  end = false,
) =>
  Math.hypot(point.x - terminal.x, point.y - terminal.y) < 1e-4 &&
  (point.route_type === "wire"
    ? point.layer
    : end
      ? point.to_layer
      : point.from_layer) === terminal.layer

const getRouteEndpointLayer = (point: WireOrVia, end: boolean) =>
  point.route_type === "wire"
    ? point.layer
    : end
      ? point.to_layer
      : point.from_layer

const getRouteEndpointKey = (point: WireOrVia, end: boolean) =>
  `${Math.round(point.x * 1e4)},${Math.round(point.y * 1e4)},${getRouteEndpointLayer(point, end)}`

const reverseRoute = (route: WireOrVia[]) =>
  route
    .toReversed()
    .map((point) =>
      point.route_type === "via"
        ? { ...point, from_layer: point.to_layer, to_layer: point.from_layer }
        : point,
    )

/**
 * A branched routed net can contain trace segments whose endpoints are both
 * internal junctions. Saved paths are linear and port-anchored, so walk the
 * route graph in terminal order and emit paths between consecutive terminals.
 * The paths can share copper where a branched tree requires it; their union
 * preserves the routed geometry while making each saved path replayable.
 */
const getBranchedRoutePaths = ({
  group,
  subcircuit,
  input,
  traces,
  portsByPcbPortId,
}: {
  group: Pick<IGroup, "pcb_group_id" | "_computePcbGlobalTransformBeforeLayout">
  subcircuit: Pick<ISubcircuit, "selectOne" | "selectAll">
  input: SimpleRouteJson
  traces: SimplifiedPcbTrace[]
  portsByPcbPortId: Map<PcbPortId, Port>
}): z.output<typeof fanoutTracePath>[] => {
  if (input.connections.length === 0) throw new Error("No routed connections")

  const routesByConnection = new Map<string, WireOrVia[][]>()
  if (input.connections.length === 1) {
    routesByConnection.set(
      input.connections[0]!.name,
      traces.map((trace) => trace.route as WireOrVia[]),
    )
  } else {
    const connectionNames = new Set(
      input.connections.map((connection) => connection.name),
    )
    for (const trace of traces) {
      if (!trace.connection_name)
        throw new Error("Branched routes need connection names")
      if (!connectionNames.has(trace.connection_name))
        throw new Error(
          `Branched route references unknown connection: ${trace.connection_name}`,
        )
      const routes = routesByConnection.get(trace.connection_name) ?? []
      routes.push(trace.route as WireOrVia[])
      routesByConnection.set(trace.connection_name, routes)
    }
  }

  const paths: z.output<typeof fanoutTracePath>[] = []
  for (const connection of input.connections) {
    const routes = routesByConnection.get(connection.name) ?? []
    if (routes.length === 0) continue
    if (
      routes.some(
        (route) =>
          route.length < 2 ||
          route.some(
            (point) =>
              point.route_type !== "wire" && point.route_type !== "via",
          ),
      )
    ) {
      throw new Error("Only port-anchored wire/via routes can be saved")
    }

    const edges: RoutedEdge[] = routes.map((route) => ({
      route,
      start: getRouteEndpointKey(route[0]!, false),
      end: getRouteEndpointKey(route.at(-1)!, true),
    }))
    const adjacency = new Map<string, number[]>()
    for (const [edgeIndex, edge] of edges.entries()) {
      if (edge.start === edge.end)
        throw new Error("Branched route contains a closed trace segment")
      adjacency.set(edge.start, [
        ...(adjacency.get(edge.start) ?? []),
        edgeIndex,
      ])
      adjacency.set(edge.end, [...(adjacency.get(edge.end) ?? []), edgeIndex])
    }

    const terminalsByNode = new Map<
      string,
      { terminal: SingleLayerConnectionPoint; port: Port }[]
    >()
    for (const [nodeKey, edgeIndices] of adjacency) {
      const candidates = connection.pointsToConnect.filter(
        (terminal) =>
          terminal.pcb_port_id &&
          edgeIndices.some((edgeIndex) => {
            const edge = edges[edgeIndex]!
            const route = edge.route
            return (
              (edge.start === nodeKey && touches(route[0]!, terminal)) ||
              (edge.end === nodeKey && touches(route.at(-1)!, terminal, true))
            )
          }),
      )
      if (candidates.length > 1)
        throw new Error("Branched route endpoint touches multiple PCB ports")
      const terminal = candidates[0]
      if (!terminal?.pcb_port_id) continue
      const port = portsByPcbPortId.get(terminal.pcb_port_id)
      if (!port) throw new Error("Branched route PCB port was not found")
      terminalsByNode.set(nodeKey, [{ terminal, port }])
    }

    const unvisited = new Set(adjacency.keys())
    const terminalOrder: {
      node: string
      terminal: SingleLayerConnectionPoint
      port: Port
    }[] = []
    const visit = (node: string, parentEdge: number | undefined) => {
      unvisited.delete(node)
      const terminal = terminalsByNode.get(node)?.[0]
      if (terminal) terminalOrder.push({ node, ...terminal })
      for (const edgeIndex of adjacency.get(node) ?? []) {
        if (edgeIndex === parentEdge) continue
        const edge = edges[edgeIndex]!
        const next = edge.start === node ? edge.end : edge.start
        if (!unvisited.has(next)) continue
        visit(next, edgeIndex)
      }
    }
    const firstNode = adjacency.keys().next().value as string | undefined
    if (!firstNode) continue
    visit(firstNode, undefined)
    if (unvisited.size > 0)
      throw new Error("Branched route contains disconnected trace segments")

    const expectedPortTerminals = connection.pointsToConnect.filter(
      (terminal) => terminal.pcb_port_id,
    )
    if (terminalOrder.length !== expectedPortTerminals.length)
      throw new Error("Branched route does not reach every PCB port")
    if (terminalOrder.length < 2)
      throw new Error("Branched route needs at least two PCB ports")

    const coveredEdges = new Set<number>()
    for (
      let terminalIndex = 0;
      terminalIndex < terminalOrder.length - 1;
      terminalIndex++
    ) {
      const source = terminalOrder[terminalIndex]!
      const destination = terminalOrder[terminalIndex + 1]!
      const queue = [source.node]
      const previous = new Map<string, { node: string; edgeIndex: number }>()
      const visited = new Set(queue)
      while (queue.length && !visited.has(destination.node)) {
        const node = queue.shift()!
        for (const edgeIndex of adjacency.get(node) ?? []) {
          const edge = edges[edgeIndex]!
          const next = edge.start === node ? edge.end : edge.start
          if (visited.has(next)) continue
          visited.add(next)
          previous.set(next, { node, edgeIndex })
          queue.push(next)
        }
      }
      if (!visited.has(destination.node))
        throw new Error("Branched route cannot connect its PCB ports")

      const pathEdges: { edgeIndex: number; from: string; to: string }[] = []
      let node = destination.node
      while (node !== source.node) {
        const step = previous.get(node)
        if (!step) throw new Error("Could not reconstruct branched route path")
        pathEdges.unshift({
          edgeIndex: step.edgeIndex,
          from: step.node,
          to: node,
        })
        node = step.node
      }

      const route: WireOrVia[] = []
      for (const pathEdge of pathEdges) {
        const edge = edges[pathEdge.edgeIndex]!
        const edgeRoute =
          pathEdge.from === edge.start ? edge.route : reverseRoute(edge.route)
        route.push(...(route.length === 0 ? edgeRoute : edgeRoute.slice(1)))
        coveredEdges.add(pathEdge.edgeIndex)
      }
      const selector =
        source.terminal.port_selector ?? source.port.getPortSelector()
      if (subcircuit.selectOne(selector, { type: "port" }) !== source.port)
        throw new Error(`PCB port selector is not unique: ${selector}`)
      const transform = inverse(
        getSavedPcbTracePathTransform(group, source.port),
      )
      paths.push(
        fanoutTracePath.parse({
          connection: selector,
          route: route.map((point) => ({
            ...point,
            ...applyToPoint(transform, point),
          })),
        }),
      )
    }
    if (coveredEdges.size !== edges.length)
      throw new Error("Branched route contains copper outside its saved paths")
  }
  return paths
}

/**
 * Export only this routing stage's copper, using port selectors and the enclosing
 * group's local PCB frame: mm, +X right, +Y up, +Z above, right-handed. These are
 * points (translation applies); physical board layers are unchanged. The input
 * SRJ and solver traces are board-world points. Neither is mutated.
 *
 * Every exported array is validated by the saved-path importer. Routes outside
 * that API's port-anchored wire/via model produce an explicit reason, never a
 * partially replayable array. Export failure must not fail successful routing.
 */
export function getAutoroutingPhasePcbTracePaths({
  group,
  subcircuit,
  input,
  traces,
  isFanout,
}: {
  group: Pick<IGroup, "pcb_group_id" | "_computePcbGlobalTransformBeforeLayout">
  subcircuit: Pick<ISubcircuit, "selectOne" | "selectAll">
  input: SimpleRouteJson
  traces: SimplifiedPcbTrace[]
  isFanout: boolean
}): AutoroutingPhasePcbTracePaths {
  try {
    const portsByPcbPortId = new Map<PcbPortId, Port>(
      (subcircuit.selectAll("port") as Port[])
        .filter((port) => port.pcb_port_id)
        .map((port) => [port.pcb_port_id!, port]),
    )
    const terminals = input.connections.flatMap(
      (connection) => connection.pointsToConnect,
    )
    const routes = traces.map((trace) => {
      if (
        trace.route.length < 2 ||
        trace.route.some(
          (point) => point.route_type !== "wire" && point.route_type !== "via",
        )
      ) {
        throw new Error("Only port-anchored wire/via routes can be saved")
      }
      return trace.route as WireOrVia[]
    })
    const endpoints = routes.map((route) => [
      terminals.filter((terminal) => touches(route[0]!, terminal)),
      terminals.filter((terminal) => touches(route.at(-1)!, terminal, true)),
    ])
    const degreeByTerminal = new Map<SingleLayerConnectionPoint, number>()
    for (const routeEndpoints of endpoints) {
      for (const terminal of new Set(routeEndpoints.flat())) {
        degreeByTerminal.set(
          terminal,
          (degreeByTerminal.get(terminal) ?? 0) + 1,
        )
      }
    }
    const paths: z.output<typeof fanoutTracePath>[] = []
    const usedPorts = new Set<Port>()
    const remainingRoutes = new Set(routes.keys())
    // Peel off leaves so each path starts at a still-available PCB port. This
    // matches the importer's endpoint-consumption order for multi-terminal nets.
    while (remainingRoutes.size) {
      let exported = false
      for (const routeIndex of remainingRoutes) {
        for (const reverse of [false, true]) {
          // Provisional fanout exits can coincide with a source pad. Only
          // physical ports can anchor a saved path; exits are not extra ports.
          const candidates = endpoints[routeIndex]![reverse ? 1 : 0]!.filter(
            (terminal) => terminal.pcb_port_id,
          )
          if (candidates.length !== 1) continue
          const terminal = candidates[0]!
          if (!terminal.pcb_port_id || degreeByTerminal.get(terminal) !== 1)
            continue
          const port = portsByPcbPortId.get(terminal.pcb_port_id)
          if (!port || usedPorts.has(port)) continue
          const selector = terminal.port_selector ?? port.getPortSelector()
          if (subcircuit.selectOne(selector, { type: "port" }) !== port) {
            throw new Error(`PCB port selector is not unique: ${selector}`)
          }
          const route = reverse
            ? routes[routeIndex]!.toReversed().map((point) =>
                point.route_type === "via"
                  ? {
                      ...point,
                      from_layer: point.to_layer,
                      to_layer: point.from_layer,
                    }
                  : point,
              )
            : routes[routeIndex]!
          const transform = inverse(getSavedPcbTracePathTransform(group, port))
          paths.push(
            fanoutTracePath.parse({
              connection: selector,
              route: route.map((point) => ({
                ...point,
                ...applyToPoint(transform, point),
              })),
            }),
          )
          usedPorts.add(port)
          remainingRoutes.delete(routeIndex)
          for (const endpoint of new Set(endpoints[routeIndex]!.flat())) {
            degreeByTerminal.set(endpoint, degreeByTerminal.get(endpoint)! - 1)
          }
          exported = true
          break
        }
      }
      if (!exported) {
        if (!isFanout) {
          const branchedPaths = getBranchedRoutePaths({
            group,
            subcircuit,
            input,
            traces,
            portsByPcbPortId,
          })
          getSavedAutoroutingPhaseTracesFromPaths({
            group,
            subcircuit,
            paths: branchedPaths,
            input,
            isFanout,
          })
          return { pcbTracePaths: branchedPaths }
        }
        throw new Error(
          "Routes contain a junction or endpoint that cannot select a unique PCB port",
        )
      }
    }
    getSavedAutoroutingPhaseTracesFromPaths({
      group,
      subcircuit,
      paths,
      input,
      isFanout,
    })
    return { pcbTracePaths: paths }
  } catch (error) {
    return {
      pcbTracePathsUnavailableReason:
        error instanceof Error ? error.message : String(error),
    }
  }
}
