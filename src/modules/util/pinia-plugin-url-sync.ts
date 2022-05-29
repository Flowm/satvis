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

  syncConfig.forEach((param: SyncConfigEntry) => {
    const query = { ...route.query };
    const deserialize = param.deserialize || defaultDeserialize;
    if (!(param.url in query)) {
      return;
    }
    try {
      console.info("Parse param", param.url, route.query[param.url]);
      const value = deserialize(query[param.url]);
      if ("valid" in param && !param.valid(value)) {
        throw new TypeError("Validation failed");
      }
      // TODO: Resolve nested values
      store[param.name] = value;
    } catch (error) {
      console.error(`Invalid URL param ${param.url} ${route.query[param.url]}: ${error}`);
      query[param.url] = undefined;
      router.replace({ query });
    }
  });
}

function stateToUrl(store: Store, syncConfig: SyncConfigEntry[]): void {
  const { router } = store;
  const route = router.currentRoute.value;

  syncConfig.forEach((param: SyncConfigEntry) => {
    const query = { ...route.query };
    const value = resolve(param.name, store);
    const serialize = param.serialize || defaultSerialize;
    console.info("State update", param.name, value);

    if ("default" in param && serialize(value) === serialize(param.default)) {
      query[param.url] = undefined;
    } else {
      query[param.url] = serialize(value);
    }

    if (query[param.url] !== route.query[param.url]) {
      router.replace({ query });
    }
  });
}

function createUrlSync({ options, store }: PiniaPluginContext): void {
  console.info("createUrlSync", options);
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
}

export default createUrlSync;
