#include "SGP4Bridge.h"

// Compiled here rather than on its own, so the vendored file stays as published
// while its warnings stay out of the build: the format ones are all in
// twoline2rv, which this app never calls.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wformat"
#pragma clang diagnostic ignored "-Wdangling-else"
#include "vallado/SGP4.cpp"
#pragma clang diagnostic pop

struct SGP4Satellite {
    elsetrec record;
};

SGP4Satellite *sgp4_create(SGP4Elements elements, int *error) {
    auto *satellite = new SGP4Satellite();
    // The catalog number is stored, never read by the propagator, and
    // sgp4init copies it into a six-byte field unchecked.
    const char satnum[5] = "";
    SGP4Funcs::sgp4init(wgs72, 'i', satnum, elements.epochDays1950, elements.bstar, elements.meanMotionDot, elements.meanMotionDDot, elements.eccentricity,
                        elements.argOfPericenter, elements.inclination, elements.meanAnomaly, elements.meanMotion, elements.raOfAscNode, satellite->record);
    *error = satellite->record.error;
    if (*error != 0) {
        delete satellite;
        return nullptr;
    }
    return satellite;
}

void sgp4_destroy(SGP4Satellite *satellite) {
    delete satellite;
}

double sgp4_mean_motion(const SGP4Satellite *satellite) {
    return satellite->record.no_unkozai;
}

SGP4Shape sgp4_shape(const SGP4Satellite *satellite) {
    return SGP4Shape{satellite->record.a, satellite->record.alta, satellite->record.altp};
}

SGP4Satellite *sgp4_copy(const SGP4Satellite *satellite) {
    return new SGP4Satellite(*satellite);
}

int sgp4_propagate(SGP4Satellite *satellite, double minutesSinceEpoch, double position[3], double velocity[3]) {
    SGP4Funcs::sgp4(satellite->record, minutesSinceEpoch, position, velocity);
    return satellite->record.error;
}
