const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

export function isValidDeviceId(value: unknown): value is string {
    return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

export function getDeviceIdFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
    const value = headers["x-device-id"];
    if (Array.isArray(value))
        return value[0];
    return value;
}
