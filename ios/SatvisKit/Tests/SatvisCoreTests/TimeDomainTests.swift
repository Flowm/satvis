import Foundation
import Testing

@testable import SatvisCore

// timeDomain.test.ts's and EumetViewImagery.test.ts's cases.
struct TimeDomainTests {
    private static func at(_ iso: String) -> Double {
        let date = (try? Date(iso, strategy: .iso8601)) ?? (try? Date(iso, strategy: .iso8601.year().month().day()))
        return date!.timeIntervalSince1970 * 1000
    }

    private static let tenMinutes = 10 * 60 * 1000.0
    private static let day = 24 * 60 * 60 * 1000.0
    /// Two runs of 10-minute frames with a gap, as GIBS publishes GOES-East.
    private static let goes = TimeDomain.parse("2026-10-04T20:00:00Z/2026-10-04T23:50:00Z/PT10M,2026-10-05T01:00:00Z/2026-10-05T11:20:00Z/PT10M")

    @Test func readsRangesSingleFramesAndDateOnlyStartsSorted() {
        #expect(
            TimeDomain.parse("2026-10-05/2026-10-05T11:30:00Z/PT10M,2015-11-24/2022-07-27/P1D,2016-01-01") == [
                .init(start: Self.at("2015-11-24"), end: Self.at("2022-07-27"), step: Self.day),
                .init(start: Self.at("2016-01-01"), end: Self.at("2016-01-01"), step: 0),
                .init(start: Self.at("2026-10-05"), end: Self.at("2026-10-05T11:30:00Z"), step: Self.tenMinutes),
            ])
    }

    @Test func skipsWhatItCannotRead() {
        #expect(TimeDomain.parse("nonsense,2026-10-05/2026-10-04/PT10M,2026-10-04/2026-10-05/P1Y,2026-10-04/2026-10-05/PT").isEmpty)
    }

    @Test func endsTheLastRangeAStepSooner() {
        #expect(
            TimeDomain.withoutLatestFrame(TimeDomain.parse("2015-11-24/2019-01-01/P1D,2019-01-03/2026-10-06/P1D")) == [
                .init(start: Self.at("2015-11-24"), end: Self.at("2019-01-01"), step: Self.day),
                .init(start: Self.at("2019-01-03"), end: Self.at("2026-10-05"), step: Self.day),
            ])
        let kept = TimeDomain.parse("2026-10-01/2026-10-03/P1D")
        #expect(TimeDomain.withoutLatestFrame(TimeDomain.parse("2026-10-01/2026-10-03/P1D,2026-10-05")) == kept)
        #expect(TimeDomain.withoutLatestFrame(TimeDomain.parse("2026-10-01/2026-10-03/P1D,2026-10-05/2026-10-05/P1D")) == kept)
        #expect(TimeDomain.withoutLatestFrame([]).isEmpty)
    }

    @Test func snapsToTheFrameAtOrBefore() {
        #expect(TimeDomain.snap(Self.goes, to: Self.at("2026-10-05T11:13:00Z")) == Self.at("2026-10-05T11:10:00Z"))
        #expect(TimeDomain.snap(Self.goes, to: Self.at("2026-10-05T11:10:00Z")) == Self.at("2026-10-05T11:10:00Z"))
        #expect(TimeDomain.snap(Self.goes, to: Self.at("2026-10-05T00:30:00Z")) == Self.at("2026-10-04T23:50:00Z"))
        #expect(TimeDomain.snap(Self.goes, to: Self.at("2026-10-06T00:00:00Z")) == Self.at("2026-10-05T11:20:00Z"))
        #expect(TimeDomain.snap(Self.goes, to: Self.at("2026-01-01T00:00:00Z")) == Self.at("2026-10-04T20:00:00Z"))
        #expect(TimeDomain.snap([], to: Self.at("2026-10-05T00:00:00Z")) == nil)
    }

    @Test func namesDailyFramesByDateAndOthersToTheSecond() {
        #expect(TimeDomain.format(Self.at("2026-10-05T00:00:00Z"), daily: true) == "2026-10-05")
        #expect(TimeDomain.format(Self.at("2026-10-05T11:20:00Z"), daily: false) == "2026-10-05T11:20:00Z")
    }

    private static func box(_ west: Double, _ south: Double, _ east: Double, _ north: Double) -> String {
        """
        <EX_GeographicBoundingBox>
          <westBoundLongitude>\(west)</westBoundLongitude>
          <eastBoundLongitude>\(east)</eastBoundLongitude>
          <southBoundLatitude>\(south)</southBoundLatitude>
          <northBoundLatitude>\(north)</northBoundLatitude>
        </EX_GeographicBoundingBox>
        """
    }

    /// A layer's capabilities as EUMETView nests them: the layer inside its workspace's.
    private static func capabilities(_ layerBox: String, _ dimension: String) -> String {
        """
        <Layer><Title>EUMETSAT</Title>\(box(-180, -90, 180, 90))
          <Layer queryable="1"><Name>rgb_geocolour</Name>\(layerBox)
            <Dimension name="time" default="2026-11-12T01:20:00Z" units="ISO8601" nearestValue="1">\(dimension)</Dimension>
          </Layer></Layer>
        """
    }

    @Test func readsTheLayersFramesAndItsOwnBox() {
        let read = EumetViewCapabilities(Self.capabilities(Self.box(-81.28, -77.35, 81.28, 77.36), "2024-09-23T00:00:00.000Z/2026-11-12T01:20:00.000Z/PT10M"))
        #expect(read.ranges == [.init(start: Self.at("2024-09-23T00:00:00Z"), end: Self.at("2026-11-12T01:20:00Z"), step: Self.tenMinutes)])
        #expect(read.bounds == [-81.28, -77.35, 81.28, 77.36])
    }

    @Test func readsAPolarLayersStepOfAnOrbit() {
        let read = EumetViewCapabilities(Self.capabilities(Self.box(-180, -84.3, 180.005, 69.79), "2020-02-17T03:01:00.000Z/2026-11-11T20:48:00.000Z/PT1H41M"))
        // 1 h 41 min.
        #expect(read.ranges.first?.step == 6_060_000.0)
        #expect(read.bounds == [-180, -84.3, 180, 69.79])
    }

    @Test func saysSoWhereTheCapabilitiesNameNothing() {
        let read = EumetViewCapabilities("<ServiceExceptionReport/>")
        #expect(read.ranges.isEmpty)
        #expect(read.bounds == nil)
    }
}
