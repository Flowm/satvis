const STORAGE_KEY = "satvis_custom_tles";

export interface CustomTleEntry {
  tle: string;
  tags: string[];
}

/**
 * Composable for managing custom TLE entries in localStorage
 */
export function useCustomTle() {
  /**
   * Save custom TLE entries to localStorage
   */
  const saveToStorage = (entries: CustomTleEntry[]): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  };

  /**
   * Load custom TLE entries from localStorage
   */
  const loadFromStorage = (): CustomTleEntry[] => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    try {
      return JSON.parse(stored) as CustomTleEntry[];
    } catch {
      return [];
    }
  };

  /**
   * Clear all custom TLE entries from localStorage
   */
  const clearStorage = (): void => {
    localStorage.removeItem(STORAGE_KEY);
  };

  /**
   * Add or update a TLE entry in storage
   * Updates if satellite with same name exists, otherwise adds new
   */
  const addOrUpdateInStorage = (entry: CustomTleEntry): void => {
    const entries = loadFromStorage();
    const name = extractSatelliteName(entry.tle);
    const existingIndex = entries.findIndex(
      (e) => extractSatelliteName(e.tle) === name
    );

    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }
    saveToStorage(entries);
  };

  /**
   * Remove a TLE entry from storage by satellite name
   */
  const removeFromStorage = (satelliteName: string): void => {
    const entries = loadFromStorage();
    const filtered = entries.filter(
      (e) => extractSatelliteName(e.tle) !== satelliteName
    );
    saveToStorage(filtered);
  };

  /**
   * Parse multi-line TLE input text into individual 3-line TLE entries
   * Handles input with or without \n escape sequences
   */
  const parseTleInput = (input: string): string[] => {
    // Replace escaped newlines with actual newlines
    const normalized = input.replace(/\\n/g, "\n");

    // Split into lines and filter empty ones
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const tles: string[] = [];

    // Group lines into 3-line TLE sets
    for (let i = 0; i < lines.length; i += 3) {
      if (i + 2 < lines.length) {
        // Validate TLE format (line 1 starts with "1 ", line 2 starts with "2 ")
        const line0 = lines[i];
        const line1 = lines[i + 1];
        const line2 = lines[i + 2];

        if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
          tles.push([line0, line1, line2].join("\n"));
        }
      }
    }

    return tles;
  };

  /**
   * Extract satellite name from TLE string (first line)
   */
  const extractSatelliteName = (tle: string): string => {
    const firstLine = tle.split("\n")[0];
    let name = firstLine?.trim() ?? "";
    // Handle format where name starts with "0 "
    if (name.startsWith("0 ")) {
      name = name.substring(2);
    }
    return name;
  };

  /**
   * Validate TLE format
   */
  const validateTle = (tle: string): { valid: boolean; error?: string } => {
    const lines = tle.split("\n");
    if (lines.length !== 3) {
      return { valid: false, error: "TLE must have exactly 3 lines" };
    }
    if (!lines[1]?.startsWith("1 ")) {
      return { valid: false, error: "Line 1 must start with '1 '" };
    }
    if (!lines[2]?.startsWith("2 ")) {
      return { valid: false, error: "Line 2 must start with '2 '" };
    }
    return { valid: true };
  };

  return {
    saveToStorage,
    loadFromStorage,
    clearStorage,
    addOrUpdateInStorage,
    removeFromStorage,
    parseTleInput,
    extractSatelliteName,
    validateTle,
  };
}
