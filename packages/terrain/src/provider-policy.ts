export interface ProviderPolicy {
  readonly provider: "google-live" | "licensed";
  readonly attribution: string;
  readonly allowedCache: "memory" | "persistent";
  readonly ttlS: number;
  readonly offline: boolean;
  readonly prefetch: boolean;
  readonly datasetLicense: string;
  readonly evidenceSha256: string | null;
}
/** Configuration boundary: unknown policy fails closed. Paid access grants no cache rights. */
export function providerPolicy(value: unknown): Readonly<ProviderPolicy> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 8 ||
    !("provider" in value) ||
    !("attribution" in value) ||
    !("allowedCache" in value) ||
    !("ttlS" in value) ||
    !("offline" in value) ||
    !("prefetch" in value) ||
    !("datasetLicense" in value) ||
    !("evidenceSha256" in value)
  )
    throw new Error("Invalid provider policy");
  const {
    provider,
    attribution,
    allowedCache,
    ttlS,
    offline,
    prefetch,
    datasetLicense,
    evidenceSha256,
  } = value;
  if (
    (provider !== "google-live" && provider !== "licensed") ||
    typeof attribution !== "string" ||
    !attribution.trim() ||
    (allowedCache !== "memory" && allowedCache !== "persistent") ||
    typeof ttlS !== "number" ||
    !Number.isSafeInteger(ttlS) ||
    ttlS < 0 ||
    ttlS > 31536000 ||
    typeof offline !== "boolean" ||
    typeof prefetch !== "boolean" ||
    typeof datasetLicense !== "string" ||
    !datasetLicense.trim() ||
    (evidenceSha256 !== null &&
      (typeof evidenceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(evidenceSha256)))
  )
    throw new Error("Invalid provider policy values");
  if (
    provider === "google-live" &&
    (allowedCache !== "memory" || offline || prefetch || ttlS !== 0)
  )
    throw new Error(
      "Google persistent caching, offline use and prefetch require a separately reviewed policy",
    );
  if (
    provider === "licensed" &&
    (allowedCache === "persistent" || offline || prefetch) &&
    !evidenceSha256
  )
    throw new Error("Missing reviewed license evidence");
  return Object.freeze({
    provider,
    attribution,
    allowedCache,
    ttlS,
    offline,
    prefetch,
    datasetLicense,
    evidenceSha256,
  });
}
