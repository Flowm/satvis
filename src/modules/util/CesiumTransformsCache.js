import * as Cesium from "cesium";

export class CesiumTransformsCache {
  static cache = {
    temeToPseudoFixed: {
      stats: {
        calls: 0,
        miss: 0,
      },
    },
    fixedToIcrfMatrix: {
      stats: {
        calls: 0,
        miss: 0,
      },
    },
  };

  /**
   * Computes and caches a rotation matrix to transform a point or vector from the Earth-Fixed frame axes (ITRF)
   * to the International Celestial Reference Frame (GCRF/ICRF) inertial frame axes
   * at a given time
   * @param {JulianDate} time The time at which to compute the rotation matrix.
   * @returns {Matrix3} The rotation matrix
   */
  static getTemeToPseudoFixedMatrix(time) {
    const cache = CesiumTransformsCache.cache.temeToPseudoFixed;
    const key = `${time.dayNumber}-${Math.floor(time.secondsOfDay)}`;
    // const key = Cesium.JulianDate.toIso8601(time, 0);
    if (!cache[key]) {
      cache[key] = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
      cache.stats.miss += 1;
    }
    cache.stats.calls += 1;
    if (cache.stats.calls % 10000 === 0) {
      console.log(`getTemeToPseudoFixedMatrix: ${cache.stats.calls} calls, ${cache.stats.miss} misses Ratio: ${cache.stats.miss / cache.stats.calls}`);
    }
    return cache[key];
  }

  /**
   * Computes and caches a rotation matrix to transform a point or vector from the Earth-Fixed frame axes (ITRF)
   * to the International Celestial Reference Frame (GCRF/ICRF) inertial frame axes
   * at a given time
   * @param {JulianDate} time The time at which to compute the rotation matrix.
   * @returns {Matrix3} The rotation matrix
   */
  static getFixedToIcrfMatrix(time) {
    const cache = CesiumTransformsCache.cache.fixedToIcrfMatrix;
    const key = `${time.dayNumber}-${Math.floor(time.secondsOfDay)}`;
    // const key = Cesium.JulianDate.toIso8601(time, 0);
    if (!cache[key]) {
      cache[key] = Cesium.Transforms.computeFixedToIcrfMatrix(time);
      cache.stats.miss += 1;
    }
    cache.stats.calls += 1;
    if (cache.stats.calls % 10000 === 0) {
      console.log(`getFixedToIcrfMatrix: ${cache.stats.calls} calls, ${cache.stats.miss} misses Ratio: ${cache.stats.miss / cache.stats.calls}`);
    }
    return cache[key];
  }
}
