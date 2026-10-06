// A C face on Google's Draco decoder (DracoSwift's prebuilt 1.5.7), so that Swift
// reads a glTF primitive's KHR_draco_mesh_compression buffer without C++
// interoperability.

#ifndef DRACO_BRIDGE_H
#define DRACO_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// A decoded triangle mesh.
typedef struct DracoMesh DracoMesh;

/// Nil when the buffer is not a Draco triangle mesh.
DracoMesh *_Nullable draco_decode(const uint8_t *_Nonnull data, size_t length);

void draco_destroy(DracoMesh *_Nullable mesh);

uint32_t draco_point_count(const DracoMesh *_Nonnull mesh);

uint32_t draco_face_count(const DracoMesh *_Nonnull mesh);

/// The faces' corners, three per face, into `indices`.
void draco_indices(const DracoMesh *_Nonnull mesh, uint32_t *_Nonnull indices);

/// How many components the attribute with this unique id has, as the glTF
/// extension's `attributes` map names it; 0 when the mesh has none.
int draco_attribute_components(const DracoMesh *_Nonnull mesh, uint32_t uniqueID);

/// The attribute's values for every point, dequantized to floats, into `values`,
/// which holds point count × components.
bool draco_attribute_floats(const DracoMesh *_Nonnull mesh, uint32_t uniqueID, float *_Nonnull values);

#ifdef __cplusplus
}
#endif

#endif
