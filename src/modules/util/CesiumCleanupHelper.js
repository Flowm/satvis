export class CesiumCleanupHelper {
  // Cleanup leftover Cesium internal data after removing satellites
  // https://github.com/CesiumGS/cesium/issues/7184
  static cleanup(viewer) {
    let ticks = 0;
    const onTickEventRemovalCallback = viewer.clock.onTick.addEventListener(() => {
      if (ticks === 0) {
        ticks += 1;
        return;
      }
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
