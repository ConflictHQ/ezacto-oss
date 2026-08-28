/** All route output crosses this seam; permission and money redaction lands here. */
export type Serializer<Source, Output, Viewer> = (
  source: Readonly<Source>,
  viewer: Readonly<Viewer>,
) => Output

export const serializeOne = <Source, Output, Viewer>(
  source: Readonly<Source>,
  viewer: Readonly<Viewer>,
  serializer: Serializer<Source, Output, Viewer>,
): Output => serializer(source, viewer)

export const serializeMany = <Source, Output, Viewer>(
  source: readonly Readonly<Source>[],
  viewer: Readonly<Viewer>,
  serializer: Serializer<Source, Output, Viewer>,
): Output[] => source.map((item) => serializeOne(item, viewer, serializer))
