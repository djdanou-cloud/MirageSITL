// ArduPilot parameter metadata in the browser (TASK-160): the generated file
// of TASK-159 is served as a separate asset and fetched once, when the first
// SITL run starts, so its 1.7 MB stay out of the application's code.
import { parseParameterMetadata, type ParameterMetadataCatalog } from "@mirage/autopilot/param-metadata";
import metadataUrl from "../../../../data/ardupilot/param-metadata.json?url";

let loading: Promise<ParameterMetadataCatalog> | null = null;

async function fetchCatalog(): Promise<ParameterMetadataCatalog> {
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`The parameter metadata could not be loaded (HTTP ${response.status})`);
  const value: unknown = await response.json();
  return parseParameterMetadata(value);
}

/** The metadata catalog, fetched and validated once; a failed load is tried again on the next call. */
export function loadParameterMetadata(): Promise<ParameterMetadataCatalog> {
  if (!loading) {
    const attempt = fetchCatalog();
    loading = attempt;
    attempt.catch(() => { if (loading === attempt) loading = null; });
  }
  return loading;
}
