#include "DracoBridge.h"

#include <memory>

#include "draco/compression/decode.h"
#include "draco/mesh/mesh.h"

struct DracoMesh {
    std::unique_ptr<draco::Mesh> mesh;
};

DracoMesh *draco_decode(const uint8_t *data, size_t length) {
    draco::DecoderBuffer buffer;
    buffer.Init(reinterpret_cast<const char *>(data), length);
    draco::Decoder decoder;
    auto decoded = decoder.DecodeMeshFromBuffer(&buffer);
    if (!decoded.ok() || !decoded.value()) {
        return nullptr;
    }
    return new DracoMesh{std::move(decoded).value()};
}

void draco_destroy(DracoMesh *mesh) { delete mesh; }

uint32_t draco_point_count(const DracoMesh *mesh) { return mesh->mesh->num_points(); }

uint32_t draco_face_count(const DracoMesh *mesh) { return mesh->mesh->num_faces(); }

void draco_indices(const DracoMesh *mesh, uint32_t *indices) {
    for (draco::FaceIndex face(0); face < mesh->mesh->num_faces(); ++face) {
        const auto &corners = mesh->mesh->face(face);
        for (int corner = 0; corner < 3; ++corner) {
            *indices++ = corners[corner].value();
        }
    }
}

int draco_attribute_components(const DracoMesh *mesh, uint32_t uniqueID) {
    const draco::PointAttribute *attribute = mesh->mesh->GetAttributeByUniqueId(uniqueID);
    return attribute ? attribute->num_components() : 0;
}

bool draco_attribute_floats(const DracoMesh *mesh, uint32_t uniqueID, float *values) {
    const draco::PointAttribute *attribute = mesh->mesh->GetAttributeByUniqueId(uniqueID);
    if (!attribute) {
        return false;
    }
    const int components = attribute->num_components();
    for (draco::PointIndex point(0); point < mesh->mesh->num_points(); ++point) {
        if (!attribute->ConvertValue<float>(attribute->mapped_index(point), static_cast<int8_t>(components), values + point.value() * components)) {
            return false;
        }
    }
    return true;
}
