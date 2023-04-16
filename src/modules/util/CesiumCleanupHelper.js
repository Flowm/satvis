import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

export class CesiumCleanupHelper {
  // Cleanup leftover Cesium internal data after removing satellites
  // https://github.com/CesiumGS/cesium/issues/7184
  static cleanup(viewer) {
    const onTickEventRemovalCallback = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      console.info("Removing leftover Cesium internal data");
      onTickEventRemovalCallback();
      /* eslint-disable no-underscore-dangle */
      const labelCollection = viewer.scene.primitives?._primitives[0]?._primitives[0]._primitives[0]._labelCollection;
      if (labelCollection) {
        labelCollection._spareBillboards.forEach((billboard) => {
          labelCollection._billboardCollection.remove(billboard);
        });
        labelCollection._spareBillboards.length = 0;
      }
      /* eslint-enable no-underscore-dangle */
    });
  }
}
