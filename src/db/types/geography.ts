import { customType } from "drizzle-orm/pg-core";

/*
  Drizzle ships a `geometry` column type but NOT `geography`, so this is hand-rolled.

  The difference matters and isn't cosmetic: ST_DWithin on a geography column takes a radius in
  METRES, on geometry it takes degrees. A "2km radius" written against geometry would quietly mean
  2 degrees — roughly 200km — and the bug looks like "search returns the whole country" rather than
  an error. Geography is the correct type here; we just have to declare it ourselves.

  On insert we hand Postgres EWKT ("SRID=4326;POINT(lng lat)"), which it parses into geography
  natively. Note the order: longitude first, then latitude. Everyone gets this backwards once.

  ⚠️ Don't SELECT this column directly — geography comes back as EWKB hex, which is useless in JS.
  When a query needs coordinates, project them: ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lng. fromDriver below only exists so the type checks out.
*/
export type LatLng = { lat: number; lng: number };

export const geography = customType<{
  data: LatLng;
  driverData: string;
}>({
  dataType() {
    return "geography(Point, 4326)";
  },
  toDriver(value: LatLng): string {
    return `SRID=4326;POINT(${value.lng} ${value.lat})`;
  },
  fromDriver(value: string): LatLng {
    // Only reached if someone selects the raw column — see the warning above. Parses the WKT form
    // (ST_AsText output), not the hex EWKB you'd get from a bare select.
    const match = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(value);
    if (!match?.[1] || !match[2]) {
      throw new Error(`geography: expected WKT POINT, got ${value.slice(0, 32)}`);
    }
    return { lng: Number(match[1]), lat: Number(match[2]) };
  },
});
