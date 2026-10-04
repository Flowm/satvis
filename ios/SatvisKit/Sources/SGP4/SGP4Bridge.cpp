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

int sgp4_propagate(const SGP4Satellite *satellite, double minutesSinceEpoch, double position[3], double velocity[3]) {
    // sgp4 writes into the record as it goes (the deep-space integrator keeps its
    // last step there), so each call works on its own copy.
    elsetrec record = satellite->record;
    SGP4Funcs::sgp4(record, minutesSinceEpoch, position, velocity);
    return record.error;
}
