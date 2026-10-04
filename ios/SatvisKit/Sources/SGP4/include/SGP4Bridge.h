// A C face on Vallado's SGP4 (vallado/SGP4.cpp), so that Swift calls it without
// C++ interoperability. Units are SGP4's own: radians, radians per minute, minutes.

#ifndef SGP4_BRIDGE_H
#define SGP4_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

/// An initialised element set. Never mutated after creation, so one may be
/// propagated from several threads at once.
typedef struct SGP4Satellite SGP4Satellite;

/// The elements a satellite is initialised from, with WGS-72 constants in
/// improved ('i') operation mode, as satellite.js does.
typedef struct {
    /// Days since 1949 December 31 00:00 UT (Julian date - 2433281.5).
    double epochDays1950;
    double bstar;
    /// Mean motion derivatives, in radians per minute squared and cubed.
    double meanMotionDot;
    double meanMotionDDot;
    double eccentricity;
    double argOfPericenter;
    double inclination;
    double meanAnomaly;
    /// Kozai mean motion, in radians per minute.
    double meanMotion;
    double raOfAscNode;
} SGP4Elements;

/// Nil when SGP4 rejects the elements; `error` then holds its error code.
SGP4Satellite *_Nullable sgp4_create(SGP4Elements elements, int *_Nonnull error);

void sgp4_destroy(SGP4Satellite *_Nullable satellite);

/// TEME position in km and velocity in km/s. Returns SGP4's error code, 0 when
/// the state is valid.
int sgp4_propagate(const SGP4Satellite *_Nonnull satellite, double minutesSinceEpoch, double position[_Nonnull 3], double velocity[_Nonnull 3]);

#ifdef __cplusplus
}
#endif

#endif
