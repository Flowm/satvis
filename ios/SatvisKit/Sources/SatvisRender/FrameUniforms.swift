import simd

/// Mirrors `FrameUniforms` in Shaders/Common.msl field for field: SIMD3<Float> and
/// Metal's float3 are both 16 bytes, so the layouts agree.
struct FrameUniforms {
    var viewProjection: simd_float4x4
    var inverseViewProjection: simd_float4x4
    var fixedToTEME: simd_float3x3
    var cameraHigh: SIMD3<Float>
    var cameraLow: SIMD3<Float>
    var cameraPosition: SIMD3<Float>
    var sunDirection: SIMD3<Float>
    var viewportSize: SIMD2<Float>
    var eyeHeight: Float
    var cameraDistance: Float
    var pointSize: Float
    /// Pixels per point: what a CSS pixel on the web is here.
    var pixelScale: Float
    /// How a satellite that cannot be seen is drawn in the sky view: 1 as usual,
    /// 0 hidden; 1 off the sky view too.
    var unseenOpacity: Float = 1
    /// Whether the observer's sky is dark, 1 or 0.
    var skyIsDark: Float = 0
}

/// A double split into two floats whose sum keeps most of its precision: the high
/// part on a 65536 grid.
///
/// Ported from CesiumJS Core/EncodedCartesian3.js. Copyright 2011-2024 CesiumJS
/// Contributors, Apache License 2.0 (Shaders/LICENSE.CesiumJS.md). Changed for
/// satvis: rewritten in Swift.
func encode(_ value: Double) -> (high: Float, low: Float) {
    let high = value >= 0 ? (value / 65536).rounded(.down) * 65536 : -((-value / 65536).rounded(.down) * 65536)
    return (Float(high), Float(value - high))
}

func encode(_ value: SIMD3<Double>) -> (high: SIMD3<Float>, low: SIMD3<Float>) {
    let (x, y, z) = (encode(value.x), encode(value.y), encode(value.z))
    return (SIMD3(x.high, y.high, z.high), SIMD3(x.low, y.low, z.low))
}

/// WGS84, in metres.
let ellipsoidRadii = SIMD3<Double>(6378137.0, 6378137.0, 6356752.3142451793)
