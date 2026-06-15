// Map the agent's direction NAME ('north'|'east'|… incl. diagonals) to a
// defines.direction. Shared by the place op (control.ts) and placement_spots
// (tools.ts) so both interpret the agent's direction string identically.
export function direction_from_name(name: string): defines.direction {
  switch (name) {
    case 'east':
      return defines.direction.east
    case 'south':
      return defines.direction.south
    case 'west':
      return defines.direction.west
    case 'northeast':
      return defines.direction.northeast
    case 'southeast':
      return defines.direction.southeast
    case 'southwest':
      return defines.direction.southwest
    case 'northwest':
      return defines.direction.northwest
    default:
      return defines.direction.north
  }
}
