import { expect, test } from "bun:test"
import type { IGroup } from "lib/components/primitive-components/Group/IGroup"
import type { ISubcircuit } from "lib/components/primitive-components/Group/Subcircuit/ISubcircuit"
import { getAutoroutingPhasePcbTracePaths } from "lib/components/primitive-components/Group/get-autorouting-phase-pcb-trace-paths"
import type { Port } from "lib/components/primitive-components/Port"
import type { SimpleRouteJson } from "lib/utils/autorouting/SimpleRouteJson"

test("repro106: branched route exports replayable port-anchored paths", () => {
  // First observed on SparkFun's CD74HC4067 mux breakout. Before this graph
  // export fix, the board routed successfully but its branched paths were not saved.
  const terminals = [
    { name: "A", x: -2, y: 0 },
    { name: "B", x: 0, y: -2 },
    { name: "C", x: 6, y: 0 },
    { name: "D", x: 4, y: 2 },
  ].map(({ name, x, y }) => {
    const port = {
      pcb_port_id: `pcb_port_${name}`,
      root: {
        db: {
          pcb_port: {
            get: () => ({ layers: ["top"] }),
          },
        },
      },
      getPortSelector: () => `.U1 > port.${name}`,
      _getGlobalPcbPositionBeforeLayout: () => ({ x, y }),
      _getGlobalPcbPositionAfterLayout: () => ({ x, y }),
    } as unknown as Port

    return {
      name,
      port,
      terminal: {
        x,
        y,
        layer: "top",
        pcb_port_id: port.pcb_port_id,
        port_selector: `.U1 > port.${name}`,
      },
    }
  })

  const ports = terminals.map(({ port }) => port)
  const subcircuit = {
    selectAll: () => ports,
    selectOne: (selector: string) =>
      ports.find((port) => port.getPortSelector() === selector),
  } as unknown as Pick<ISubcircuit, "selectOne" | "selectAll">
  const group = {
    pcb_group_id: null,
    _computePcbGlobalTransformBeforeLayout: () => ({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    }),
  } as unknown as Pick<
    IGroup,
    "pcb_group_id" | "_computePcbGlobalTransformBeforeLayout"
  >

  const wirePoint = (
    x: number,
    y: number,
    endpoint: "start" | "end",
    pcbPortId?: string | null,
  ) => ({
    route_type: "wire" as const,
    x,
    y,
    width: 0.2,
    layer: "top" as const,
    ...(pcbPortId
      ? endpoint === "start"
        ? { start_pcb_port_id: pcbPortId }
        : { end_pcb_port_id: pcbPortId }
      : {}),
  })
  const [a, b, c, d] = terminals
  const traces = [
    {
      connection_name: "shared_net",
      route: [
        wirePoint(a!.terminal.x, a!.terminal.y, "start", a!.port.pcb_port_id),
        wirePoint(0, 0, "end"),
      ],
    },
    {
      connection_name: "shared_net",
      route: [
        wirePoint(b!.terminal.x, b!.terminal.y, "start", b!.port.pcb_port_id),
        wirePoint(0, 0, "end"),
      ],
    },
    {
      connection_name: "shared_net",
      route: [wirePoint(0, 0, "start"), wirePoint(4, 0, "end")],
    },
    {
      connection_name: "shared_net",
      route: [
        wirePoint(4, 0, "start"),
        wirePoint(c!.terminal.x, c!.terminal.y, "end", c!.port.pcb_port_id),
      ],
    },
    {
      connection_name: "shared_net",
      route: [
        wirePoint(4, 0, "start"),
        wirePoint(d!.terminal.x, d!.terminal.y, "end", d!.port.pcb_port_id),
      ],
    },
  ]

  const result = getAutoroutingPhasePcbTracePaths({
    group,
    subcircuit,
    input: {
      connections: [
        {
          name: "shared_net",
          pointsToConnect: terminals.map(({ terminal }) => terminal),
        },
      ],
    } as unknown as SimpleRouteJson,
    traces: traces as Parameters<
      typeof getAutoroutingPhasePcbTracePaths
    >[0]["traces"],
    isFanout: false,
  })

  expect(result.pcbTracePathsUnavailableReason).toBeUndefined()
  expect(result.pcbTracePaths).toHaveLength(3)
  expect(result.pcbTracePaths?.map((path) => path.connection)).toEqual([
    ".U1 > port.A",
    ".U1 > port.B",
    ".U1 > port.C",
  ])
})
