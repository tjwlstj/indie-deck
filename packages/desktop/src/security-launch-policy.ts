/** Only an explicit, persisted false skips the launch-time executable scan.
 * Installation and manual scans are controlled separately. */
export async function scanLaunchTarget(value: unknown, scan: () => Promise<unknown>): Promise<void> {
  if (value !== false) await scan();
}
