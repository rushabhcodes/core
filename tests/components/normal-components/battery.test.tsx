import { test, expect } from "bun:test"
import { getTestFixture } from "tests/fixtures/get-test-fixture"

test("<battery /> component", async () => {
  const { circuit } = getTestFixture()

  circuit.add(
    <board width="12mm" height="10mm">
      <battery
        name="U1"
        footprint="axial_p0.3in"
        pcbX={0}
        pcbY={0}
        voltage="3.7V"
      />
    </board>,
  )

  circuit.render()

  expect(circuit.db.source_component.list()).toContainEqual(
    expect.objectContaining({ name: "U1", voltage: 3.7 }),
  )
  expect(circuit).toMatchPcbSnapshot(import.meta.path)
  expect(circuit).toMatchSchematicSnapshot(import.meta.path)
})
