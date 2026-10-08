// A C face on Vallado's SGP4 (vallado/SGP4.cpp), so that Swift calls it without
// C++ interoperability. Units are SGP4's own: radians, radians per minute, minutes.

#ifndef SGP4_BRIDGE_H
#define SGP4_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

/// An initialised element set. Propagating one writes into it: the deep-space
/// integrator keeps its last step there and goes on from it, on a fixed
/// 720-minute grid from the epoch, restarting there when time goes back. The
/// states are the same either way; one propagated at a time, from one thread.
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

/// A copy to propagate apart from the original.
SGP4Satellite *_Nonnull sgp4_copy(const SGP4Satellite *_Nonnull satellite);

/// The mean motion SGP4 recovered from the Kozai one, in radians per minute.
double sgp4_mean_motion(const SGP4Satellite *_Nonnull satellite);

/// What sgp4init derived from the elements, in Earth radii: the semi-major axis,
/// and the apogee and perigee as heights above the surface.
typedef struct {
    double semiMajorAxis;
    double apogeeAltitude;
    double perigeeAltitude;
} SGP4Shape;

SGP4Shape sgp4_shape(const SGP4Satellite *_Nonnull satellite);

/// TEME position in km and velocity in km/s. Returns SGP4's error code, 0 when
/// the state is valid.
int sgp4_propagate(SGP4Satellite *_Nonnull satellite, double minutesSinceEpoch, double position[_Nonnull 3], double velocity[_Nonnull 3]);

#ifdef __cplusplus
}
#endif

#endif
