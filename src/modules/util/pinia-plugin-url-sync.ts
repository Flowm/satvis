import { PiniaPluginContext } from "pinia";

export interface SyncConfigEntry {
  name: String;           // Object name/path in pinia store
  url?: String;           // Alternative name of url param, defaults to name
  serialize?: Function;   // Convert state to url string
  deserialize?: Function; // Convert url string to state
  valid?: Function;       // Run validation function after deserialization to filter invalid values
  default?: Any;          // Default value (removes this value from url)
}
const defaultSerialize = (v) => String(v);
const defaultDeserialize = (v) => String(v);

function resolve(path, obj, separator = ".") {
  const properties = Array.isArray(path) ? path : path.split(separator);
  return properties.reduce((prev, curr) => prev && prev[curr], obj);
}

function urlToState(store: Store, syncConfig: SyncConfigEntry[]): void {
  const { router } = store;
  const route = router.currentRoute.value;

  syncConfig.forEach((config: SyncConfigEntry) => {
    const param = config.url || config.name;
    const deserialize = config.deserialize || defaultDeserialize;

    const query = { ...route.query };
    if (!(param in query)) {
      return;
    }
    try {
      console.info("Parse url param", param, route.query[param]);
      const value = deserialize(query[param]);
      if ("valid" in config && !config.valid(value)) {
        throw new TypeError("Validation failed");
      }
      // TODO: Resolve nested values
      store[config.name] = value;
      config.setFromUrl = true;
    } catch (error) {
      console.error(`Invalid url param ${param} ${route.query[param]}: ${error}`);
      query[param] = undefined;
      router.replace({ query });
    }
  });
}

function stateToUrl(store: Store, syncConfig: SyncConfigEntry[]): void {
  const { router } = store;
  const route = router.currentRoute.value;

  const params = new URLSearchParams(location.search);
  syncConfig.forEach((config: SyncConfigEntry) => {
    const value = resolve(config.name, store);
    const param = config.url || config.name;
    const serialize = config.serialize || defaultSerialize;
    console.info("State update", config.name, value);

    if ("default" in config && serialize(value) === serialize(config.default)) {
      params.delete(param);
    } else {
      params.set(param, serialize(value));
    }
  });
  window.history.pushState({}, "", `?${params.toString().replaceAll("%2C", ",")}`);
}

function createUrlSync({ options, store }: PiniaPluginContext): void {
  // console.info("createUrlSync", options);
  if (!options.urlsync?.enabled && !options.urlsync?.config) {
    return;
  }

  // Set state from url params on page load
  store.router.isReady().then(() => {
    urlToState(store, options.urlsync.config);
  });

  // Subscribe to store updates and sync them to url params
  store.$subscribe(() => {
    stateToUrl(store, options.urlsync.config);
  });

  // Helper getters and setters to allow conditional overrides of store values
  store.getConfigForKey = (key) => {
    return options.urlsync.config.find((entry) => entry.name === key);
  }

  store.setIfDefault = (key, value) => {
    const config = store.getConfigForKey(key);
    const serialize = config.serialize || defaultSerialize;
    console.log("CHK", key, serialize(store[key]), serialize(config.default));
    // if ("default" in config && serialize(store[key]) === serialize(config.default)) {
    if (!config.setFromUrl) {
      console.log("WRT", key, value);
      store[key] = value;
    }
  }
}

export default createUrlSync;
