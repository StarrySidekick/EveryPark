#!/usr/bin/env python3
"""
Build data/places.json — the aggregated dataset the map runs on.

This is a faithful port of the pipeline that used to run in the browser on
every page load: pull from each public source, apply the public-access
rules, drop duplicates, work out what's actually at each place, then
resolve "can I go there?". The answer is the same every time, so it's
computed once here instead of on every visit.

    python3 buildplaces.py --raw <dir> --data data -o data/places.json

Sources (all public):
  CT DEEP property + boat launches      state.json, stateextra, boat
  National Park Service / USFWS / USACE national.json
  OpenStreetMap (via Esri mirrors)      municipal, preserves, cemeteries,
                                        landuse, facilities, water, trails
  USGS PAD-US                           access ratings + gap-filling places
  Hand-added                            additions.json
"""

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict

# ---------------------------------------------------------------- rules
# Members-only places are not public land, however nice they are. The rule
# of thumb: paid-but-open-to-anyone stays, exclusive-entry goes.
# Membership is the price of entry, so these are not public land. Applied
# to every source.
MEMBERS_ONLY = re.compile(
    r"\bclub\b|racquet|members only|homeowners|\bhoa\b|"
    r"(beach|lake|shore|point|improvement) association|"
    # Sportsmen's and rod-and-gun associations own a lot of Connecticut
    # open space, but you have to belong.
    r"sportsman|sportsmen|rod (and|&) gun|fish (and|&) game|"
    r"\bscout\b|scout reservation", re.I)

# State and federal land has its own authoritative layer. This drops the
# copies that OpenStreetMap and PAD-US also carry — it must NOT be applied
# to the state and national layers themselves, or every state park
# disappears from the map.
DUPLICATE_LAYER = re.compile(
    r"state (park|forest)|scenic reserve|national (park|historical|scenic)", re.I)

EXCLUDE = re.compile(MEMBERS_ONLY.pattern + "|" + DUPLICATE_LAYER.pattern, re.I)

# Some PAD-US name fields contain leaked XML from whatever produced the
# export, e.g. '<ArcGIS Type="Editing"><ArrayOfPropertySet ...'.
JUNK_NAME = re.compile(r"[<>]|ArcGIS|ArrayOf|PropertySet|^\W+$")

# Connecticut's reservations are sovereign land — under CGS ch. 824 nobody
# may enter without the tribe's written permission — and burial grounds
# are not visitor destinations. Matched on burial-specific wording so that
# ordinary municipal cemeteries named for local landmarks survive.
TRIBAL_EXCLUDE = re.compile(
    r"tribal burial|indian burial|burial site|"
    r"\b(schaghticoke|paugussett|pequot|mohegan|montaukett|niantic|nipmuc|"
    r"mashantucket|golden hill)\b.*(burial|reservation)|"
    r"\breservation\b.*(indian|tribal)", re.I)

ALLOW = {"westport longshore club park", "longshore club park"}
GENERIC_NAME = re.compile(r"^(town|city|borough|village) of\b|^private\b|"
                          r"^unknown$|^state of\b|^designation$", re.I)

OP_STATE = re.compile(r"Department of Energy and Environmental|State of Connecticut|"
                      r"\bDEEP\b|Connecticut DEP", re.I)
OP_FED = re.compile(r"National Park Service|United States of America|U\.?S\.? Fish|"
                    r"Fish and Wildlife|Army Corps", re.I)
OP_WATER = re.compile(r"Water Supply|Water Authority|Water Company|Bureau of Water|"
                      r"Aquarion|Regional Water", re.I)
OP_TOWN = re.compile(r"^(Town|City|Borough|Village) of\b|^City\b|Parks (and|&) Recreation", re.I)
OP_UNI = re.compile(r"University|College|Yale|UConn|Academy", re.I)
OP_TRUST = re.compile(r"Land Trust|Conservancy|Conservation Trust|Land Conservation|"
                      r"Audubon|Nature Center|Nature Conservancy|Preservation|\bTrust\b", re.I)

BURYING_RE = re.compile(r"burying|burial ground|old cemetery|ancient", re.I)
HISTORIC_RE = re.compile(r"\bfort\b|castle|battle|memorial|monument|historic|heritage|"
                         r"lighthouse|\bmill\b|homestead|birthplace|colonial|"
                         r"revolutionary|\bgreen\b$", re.I)

SHORE_TOWNS = {"Greenwich", "Stamford", "Darien", "Norwalk", "Westport", "Fairfield",
               "Bridgeport", "Stratford", "Milford", "West Haven", "New Haven",
               "East Haven", "Branford", "Guilford", "Madison", "Clinton", "Westbrook",
               "Old Saybrook", "Old Lyme", "East Lyme", "Waterford", "New London",
               "Groton", "Stonington"}

SPORT_LABEL = {
    "soccer": "soccer", "baseball": "baseball", "softball": "softball",
    "basketball": "basketball", "tennis": "tennis", "pickleball": "pickleball",
    "volleyball": "volleyball", "football": "football", "american_football": "football",
    "skateboard": "skate park", "golf": "golf", "disc_golf": "disc golf",
    "bocce": "bocce", "cricket": "cricket", "lacrosse": "lacrosse", "hockey": "hockey",
    "ice_hockey": "ice hockey", "equestrian": "equestrian", "athletics": "track",
    "running": "track", "multi": "multi-sport", "swimming": "swimming",
    "shuffleboard": "shuffleboard", "badminton": "badminton", "horseshoes": "horseshoes",
    "field_hockey": "field hockey", "rugby": "rugby", "handball": "handball",
    "beachvolleyball": "beach volleyball", "table_tennis": "table tennis",
}
LEGEND_LABEL = {"Wildlife Area": "Wildlife Management Area",
                "Wildlife Sanctuary": "Wildlife Sanctuary",
                "Flood Control": "Flood Control Area", "Fish Hatchery": "Fish Hatchery"}
LANDUSE_LABEL = {"recreation_ground": "Recreation Area", "village_green": "Town Green",
                 "forest": "Forest"}
STEWARD_BY_TYPE = {"state": "State of Connecticut (DEEP)", "national": "Federal government",
                   "town": "Town or city", "preserve": "Land trust or non-profit",
                   "cemetery": "Cemetery association or town"}
KIND_BY_TYPE = {"state": "State Park", "national": "Federal Land", "town": "Town Park",
                "preserve": "Preserve", "cemetery": "Cemetery"}
ACCESS_LABEL = {"open": "Open to all", "permission": "Open by permission",
                "closed": "Closed to the public", "unknown": "Access unverified"}
ACCESS_WORD = {"OA": "Open", "RA": "Restricted", "XA": "Closed", "UK": "Unknown",
               "Open Access": "Open", "Restricted Access": "Restricted",
               "Closed": "Closed", "Closed Access": "Closed", "Unknown": "Unknown"}
PADUS_TYPE = {"NPS": "national", "FWS": "national", "USFS": "national", "USACE": "national",
              "DOD": "national", "BLM": "national", "OTHF": "national", "BOEM": "national",
              "USBR": "national", "NOAA": "national", "NRCS": "national", "ARS": "national",
              "SPR": "state", "SDC": "state", "SFW": "state", "SDNR": "state",
              "SLB": "state", "SDOL": "state", "OTHS": "state",
              "CITY": "town", "CNTY": "town", "UNKL": "town", "REG": "town", "RWD": "town",
              "NGO": "preserve", "PVT": "preserve", "JNT": "preserve", "OTHR": "preserve",
              "UNK": "preserve"}
OWNER_WORD = {"NPS": "National Park Service", "FWS": "US Fish & Wildlife Service",
              "USFS": "US Forest Service", "USACE": "US Army Corps of Engineers",
              "DOD": "US Department of Defense", "SDC": "State conservation agency",
              "SPR": "State parks agency", "SFW": "State fish & wildlife agency",
              "SDNR": "State natural resources agency", "OTHS": "State government",
              "CITY": "City or town", "CNTY": "County", "REG": "Regional agency",
              "NGO": "Non-profit / land trust", "PVT": "Private owner",
              "JNT": "Jointly owned", "UNK": "Unknown owner"}
DESIG_WORD = {"PAGR": "Private agricultural", "PRAN": "Private ranch",
              "PFOR": "Private forest stewardship", "PCON": "Private conservation",
              "PPRK": "Private park", "PREC": "Private recreation",
              "CONE": "Conservation easement", "AGRE": "Agricultural easement",
              "RANE": "Ranch easement", "FORE": "Forest stewardship easement",
              "RECE": "Recreation easement", "OTHE": "Easement",
              "UNKE": "Easement (type unrecorded)", "SP": "State park",
              "SCA": "State conservation area", "SREC": "State recreation area",
              "LP": "Local park", "LCA": "Local conservation area",
              "LREC": "Local recreation area", "NWR": "National wildlife refuge",
              "NP": "National park", "NT": "National scenic or historic trail",
              "WPA": "Watershed protection area"}

TRAIL_CELL = 0.0015
PADUS_MATCH_M = 500
PARKING_RADIUS_M = 400

# A conservation easement is a restriction on what the owner may build. It
# is not a right of way, and the land underneath stays private — so these
# are protected land you still can't visit. PAD-US records them under the
# owner's name, which is why they arrive called "44 Sunny Ridge Road, LLC"
# or "417 Eastern Blvd." A recreation easement (RECE) is the exception:
# that one does grant public access, so it stays.
EASEMENT_DESIG = {"CONE", "AGRE", "RANE", "FORE", "OTHE", "UNKE",
                  "PAGR", "PRAN", "PFOR"}

# Names that are a parcel, not a place: street addresses, companies, and
# housing developments whose open space PAD-US happens to record.
PARCEL_NAME = re.compile(
    r"^\d+\s|\bLLC\b|\bL\.L\.C|\bInc\b|\bAssociates\b|Subdivision|\bLP\b|"
    r"\bLtd\b|Properties|Realty|Development\b|\bEstates\b", re.I)

# A company or housing development, whatever the source. Applied to every
# place. Kept narrower than PARCEL_NAME so that "Stony Hill Subdivision
# Open Space" — which really is the open space — still gets through.
COMPANY_NAME = re.compile(
    r"\bLLC\b|\bL\.L\.C|\bInc\.?$|\bIncorporated\b|\bAssociates\b|Realty|"
    r"\bProperties\b|\bEstates\b|Development Corp", re.I)


# ------------------------------------------------------------- geometry
def dist_m(alat, alng, blat, blng):
    dy = (alat - blat) * 111000
    dx = (alng - blng) * 111000 * math.cos(math.radians(alat))
    return math.hypot(dx, dy)


class Grid:
    """Same coarse spatial hash the browser used, so results match."""

    def __init__(self, cell):
        self.cell = cell
        self.g = defaultdict(list)

    def add(self, lat, lng, val):
        self.g[(math.floor(lat / self.cell), math.floor(lng / self.cell))].append((lat, lng, val))

    def near(self, lat, lng, radius_m):
        span = max(1, math.ceil(radius_m / 111000 / self.cell))
        i0, j0 = math.floor(lat / self.cell), math.floor(lng / self.cell)
        out = []
        for i in range(i0 - span, i0 + span + 1):
            for j in range(j0 - span, j0 + span + 1):
                for (la, ln, v) in self.g.get((i, j), ()):
                    d = dist_m(lat, lng, la, ln)
                    if d <= radius_m:
                        out.append((d, v))
        return out


class Towns:
    """Point-in-polygon town lookup, matching buildTownIndex/findTown."""

    def __init__(self, geojson):
        self.items = []
        for f in geojson.get("features") or []:
            name = None
            for k in ("NAME", "TOWN", "name", "town"):
                if (f.get("properties") or {}).get(k):
                    name = f["properties"][k]
                    break
            g = f.get("geometry") or {}
            polys = []
            if g.get("type") == "Polygon":
                polys = [g["coordinates"]]
            elif g.get("type") == "MultiPolygon":
                polys = g["coordinates"]
            for poly in polys:
                ring = poly[0]
                xs = [c[0] for c in ring]
                ys = [c[1] for c in ring]
                self.items.append((name, min(xs), min(ys), max(xs), max(ys), ring))

    def find(self, lat, lng):
        for (name, x0, y0, x1, y1, ring) in self.items:
            if not (x0 <= lng <= x1 and y0 <= lat <= y1):
                continue
            inside = False
            n = len(ring)
            j = n - 1
            for i in range(n):
                xi, yi = ring[i][0], ring[i][1]
                xj, yj = ring[j][0], ring[j][1]
                if ((yi > lat) != (yj > lat)) and \
                   (lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi):
                    inside = not inside
                j = i
            if inside:
                return name
        return None


def park_radius_m(p):
    acres = p.get("acres") or 0
    if not acres:
        return 120.0
    return min(2200.0, max(90.0, math.sqrt(acres * 4047 / math.pi)))


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def nm_lower(s):
    return str(s or "").lower()


# ----------------------------------------------------------- classifying
def classify(p):
    A = p.setdefault("attrs", {})
    official = A.get("officialAccess")
    if official == "Open":
        p["access"] = "open"
    elif official == "Closed":
        p["access"] = "closed"
    elif official == "Restricted":
        p["access"] = "permission"
    elif p["type"] in ("state", "national", "town"):
        p["access"] = "open"
    elif p["type"] in ("preserve", "cemetery"):
        p["access"] = "permission"
    else:
        p["access"] = "unknown"

    A["visitable"] = bool(A.get("trails") or A.get("parking") or A.get("sports")
                          or A.get("playground") or A.get("beach") or A.get("pool"))
    if not A["visitable"] and p["access"] != "closed" and not official:
        p["access"] = "unknown"

    p["accessLabel"] = ACCESS_LABEL[p["access"]]
    if p["access"] == "open":
        if official == "Open":
            why = "Officially open (USGS PAD-US)."
        elif p["type"] == "state":
            why = "State land — public by default."
        elif p["type"] == "national":
            why = "Federal land — public by default."
        else:
            why = "Municipal land — Connecticut town parks must admit non-residents."
    elif p["access"] == "permission":
        why = ("Privately held but customarily open. You're here by the owner's "
               "permission, not by legal right — Connecticut's Recreational Use "
               "Statute is what makes this common. Respect posted signs.")
    elif p["access"] == "closed":
        why = "Recorded as closed to public access."
    else:
        why = ("We found no trail, parking or facility here, and no official rating. "
               "It may still be open — we just can't confirm it.")
    p["accessWhy"] = why
    p["steward"] = (A.get("officialOwner") or p.get("agency")
                    or STEWARD_BY_TYPE.get(p["type"]) or "Unknown")
    p["kind"] = p.get("subtype") or KIND_BY_TYPE.get(p["type"]) or "Public land"


def score_access(p):
    A = p.setdefault("attrs", {})
    A["visitable"] = bool(A.get("trails") or A.get("parking") or A.get("sports")
                          or A.get("playground") or A.get("beach") or A.get("pool"))
    A["accessNote"] = ("Trails mapped" if A.get("trails")
                       else "Parking nearby, no mapped trail" if A.get("parking")
                       else "Facilities on site" if A["visitable"]
                       else "No mapped trail or parking")
    classify(p)


# ------------------------------------------------------------------ build
class Builder:
    def __init__(self, towns):
        self.towns = towns
        self.places = []
        self.seen = set()          # name + coarse position, for dedupe

    def key(self, name, lat, lng, scale=300):
        return f"{str(name).lower()}|{round(lat * scale)}|{round(lng * scale)}"

    def add(self, **p):
        name = (p.get("name") or "").strip()
        if not name or p.get("lat") is None:
            return False
        if len(name) < 3 or JUNK_NAME.search(name):
            return False
        # One gate for every source, so a members-only club or a company
        # parcel can't slip in just because it arrived from OpenStreetMap
        # rather than PAD-US. Deliberately only the members-only and
        # company rules — the duplicate-layer rule is per-source.
        if name.lower() not in ALLOW and (MEMBERS_ONLY.search(name)
                                          or COMPANY_NAME.search(name)):
            return False
        p["name"] = name
        k = self.key(name, p["lat"], p["lng"])
        if k in self.seen:
            return False
        self.seen.add(k)
        p.setdefault("attrs", {})
        self.places.append(p)
        return True

    def dedupe(self):
        """
        Drop repeats of the same place arriving from different sources.
        The per-source key only catches near-identical coordinates; the
        same park mapped by DEEP and by OpenStreetMap can sit a few
        hundred metres apart and survive as two pins. Same name within
        800 m is the same place — keep whichever record knows most.
        """
        def richness(p):
            return (len(p.get("attrs") or {}), p.get("acres") or 0,
                    1 if p.get("url") else 0, 1 if p.get("subtype") else 0)

        drop = set()

        # Same name in the same town is one place, however far apart the
        # parcels sit. Big properties arrive as many parcels — the
        # Quinebaug Fish Hatchery and the flood-control sites each came
        # through half a dozen times — and nobody wants six identical
        # pins for one destination.
        by_town = defaultdict(list)
        for p in self.places:
            by_town[(norm(p["name"]), p.get("town"))].append(p)
        for group in by_town.values():
            if len(group) < 2:
                continue
            for b in sorted(group, key=richness, reverse=True)[1:]:
                drop.add(id(b))

        # Across town lines, fall back to proximity: the same park mapped
        # by two sources can straddle a boundary.
        by_name = defaultdict(list)
        for p in self.places:
            if id(p) not in drop:
                by_name[norm(p["name"])].append(p)
        for group in by_name.values():
            if len(group) < 2:
                continue
            group = sorted(group, key=richness, reverse=True)
            for i, a in enumerate(group):
                if id(a) in drop:
                    continue
                for b in group[i + 1:]:
                    if id(b) in drop:
                        continue
                    if dist_m(a["lat"], a["lng"], b["lat"], b["lng"]) < 800:
                        drop.add(id(b))

        before = len(self.places)
        self.places = [p for p in self.places if id(p) not in drop]
        return before - len(self.places)


def load(path):
    with open(path) as fh:
        return json.load(fh)


# --------------------------------------------------------- boundaries
def attach_geometry(places, raw_dir):
    """
    Give every place its real boundary, and an area measured from it.

    Acreage previously came from whatever the source happened to record —
    27% coverage — and that number drives the trail search radius, so a
    park with no recorded acreage was judged by a 120 m circle. Measuring
    the polygon instead takes it to nearly everything, and is a fact
    rather than a field someone remembered to fill in.

    A place with no boundary at all can't be assessed for access, so it
    can't be a verified park. That's recorded here as `shaped`.
    """
    import glob
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree

    polys, meta = [], []
    for path in sorted(glob.glob(os.path.join(raw_dir, "ep-*.geojson"))):
        lay = os.path.basename(path).split("ep-")[1].split(".")[0]
        if lay in ("trails", "blueblazed"):
            continue
        try:
            feats = load(path)["features"]
        except Exception:                          # noqa: BLE001
            continue
        for f in feats:
            g = f.get("geometry")
            if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            try:
                s = shape(g)
                if not s.is_valid:
                    s = s.buffer(0)
                if s.is_empty:
                    continue
            except Exception:                      # noqa: BLE001
                continue
            pr = f.get("properties") or {}
            polys.append(s)
            meta.append((lay, norm(pr.get("PROPERTY") or pr.get("Unit_Nm")
                                   or pr.get("name") or "")))
    if not polys:
        return 0

    tree = STRtree(polys)
    # Total area per property name, computed once — a big forest is dozens
    # of parcels and we want the property, not the parcel underfoot.
    # Keyed by (source layer, name). Summing on name alone triples a state
    # park's acreage, because DEEP, PAD-US and OpenStreetMap each carry a
    # copy of it — Sleeping Giant came out at 3,495 acres against a real
    # 1,575.
    area_by_name = defaultdict(float)
    for i, (lay, m) in enumerate(meta):
        if m:
            area_by_name[(lay, m)] += polys[i].area
    # Every polygon that carries a given name, so a property whose
    # representative point misses its own parcels can still be found.
    by_name = defaultdict(list)
    for i, (lay, m) in enumerate(meta):
        if m:
            by_name[m].append(i)

    hits = 0
    moved = 0
    for p in places:
        pt = Point(p["lng"], p["lat"])
        cands = [i for i in tree.query(pt) if polys[i].contains(pt)]

        if not cands:
            # Big properties are fragmented, and the mean centre of a
            # scattered forest lands in a private-land gap between its own
            # parcels. Cockaponset State Forest — 17,000 acres — sat
            # outside every polygon it owns. Fall back to the name, then
            # move the pin somewhere actually inside the land.
            nm0 = norm(p["name"])
            near = [i for i in by_name.get(nm0, ())
                    if dist_m(p["lat"], p["lng"],
                              polys[i].centroid.y, polys[i].centroid.x) < 8000]
            if not near:
                continue
            cands = near
            big = max(near, key=lambda i: polys[i].area)
            rp = polys[big].representative_point()
            p["lat"], p["lng"] = round(rp.y, 5), round(rp.x, 5)
            moved += 1
        nm = norm(p["name"])
        named = [i for i in cands if meta[i][1] == nm]
        if not named:
            # The pin is inside SOMEBODY's polygon — just not its own.
            # This is the "node separated from its shape" case: the
            # source centroid landed in a neighbouring parcel, so the
            # marker floats apart from the boundary it belongs to, and
            # the acreage below would be measured from the wrong shape.
            # If this place's own named polygons exist nearby, snap the
            # pin inside the biggest one and describe THAT land instead.
            near = [i for i in by_name.get(nm, ())
                    if dist_m(p["lat"], p["lng"],
                              polys[i].centroid.y, polys[i].centroid.x) < 8000]
            if near:
                big = max(near, key=lambda i: polys[i].area)
                rp = polys[big].representative_point()
                p["lat"], p["lng"] = round(rp.y, 5), round(rp.x, 5)
                moved += 1
                cands = near
                named = near
        # DEEP's parcels are the authoritative measure of state land, so
        # prefer them when more than one source describes this place.
        RANK = {"stateland": 0, "townparks": 1, "cemeteries": 2,
                "landuse": 3, "preserves": 4, "padus": 5, "parcels": 6}
        named.sort(key=lambda i: RANK.get(meta[i][0], 9))
        lat = p["lat"]
        deg2acre = math.cos(math.radians(lat)) * (111320 ** 2) / 4046.86

        if named:
            # A big property arrives as many parcels sharing one name —
            # Pachaug State Forest is dozens of them. Taking the parcel the
            # centroid happens to land in reported 4,481 acres against a
            # real 26,662, so sum every parcel of that name instead.
            area = area_by_name[(meta[named[0]][0], nm)]
        else:
            # No name to go on: the smallest polygon containing the point is
            # the most specific description of where you're standing.
            area = polys[min(cands, key=lambda i: polys[i].area)].area
        acres = area * deg2acre
        if acres >= 0.1:
            p["acres"] = round(acres, 1) if acres < 10 else round(acres)
        p.setdefault("attrs", {})["shaped"] = True
        hits += 1
    if moved:
        print(f"  {moved:,} pins moved inside their own boundary", flush=True)
    return hits


# ------------------------------------------------------- what is a park
# A park has to pass three tests, and we have to be able to show our
# working on each. Anything we can't evidence is marked unverified rather
# than quietly presented as a park.
#
#   legal     you may lawfully walk there
#   physical  there's a realistic way in and something to do
#   free      no admission charge
#
# Fee is recorded in three states, because Connecticut's state parks are
# free to walk into but charge for parking, and calling that simply
# "paid" would be wrong.
def fee_state(p):
    txt = " ".join(str(p.get(k) or "") for k in ("fee", "note")).lower()

    # Say-so of being free wins outright. Matching on the word "admission"
    # alone marked "Free admission" as paid, which is exactly backwards.
    if re.search(r"\bfree\b(?!.*\b(fee|charge|\$)\b)", txt):
        free_text = True
    else:
        free_text = False

    charges = re.search(r"admission (fee|charge|\$)|entry fee|entrance fee|"
                        r"\bticket\b|\$\d+(?!.*parking)", txt)
    parking_charge = re.search(r"parking (fee|charge|\$)|passport to the parks|"
                               r"out-of-state|per vehicle", txt)

    if charges and not free_text:
        return "paid"
    if parking_charge:
        return "parking"
    if free_text:
        return "free"
    if p["type"] == "state":
        # Free to walk into. Connecticut-registered vehicles park free under
        # Passport to the Parks; out-of-state vehicles pay at staffed parks.
        return "parking"
    return "free"          # assume free unless there's evidence otherwise


def verify_all(places):
    for p in places:
        A = p.setdefault("attrs", {})
        # `access` is a derived field and isn't stored in the file, so
        # recompute it here rather than assuming it survived the round trip.
        if not p.get("access"):
            score_access(p)
        # A cited `private` finding (members-only beach association, club
        # land) overrides everything: it fails the legal test no matter
        # what the automated sources inferred. Mirrored in app.js
        # classify(), which maps it to access "closed".
        legal = (p.get("access") in ("open", "permission")
                 and not A.get("private"))
        # `reachable` is set by a cited category rule — e.g. Connecticut
        # state land is open to walk by regulation, and a cemetery is walk-in
        # daylight public space. Both are genuinely visitable without anyone
        # having mapped a trail inside them, and asserting a trail we haven't
        # seen would be putting a false fact in the data to game the test.
        physical = bool(A.get("trails") or A.get("parking") or A.get("sports")
                        or A.get("playground") or A.get("beach") or A.get("pool")
                        or A.get("reachable"))
        shaped = bool(A.get("shaped"))
        fee = fee_state(p)

        why = []
        if not legal:
            why.append("members-only — not open to the general public"
                       if A.get("private") else
                       "no confirmed legal right or permission to walk here")
        if not physical:
            why.append("no mapped trail, parking or facility, so no confirmed way in")
        if not shaped:
            why.append("no mapped boundary, so its extent is unknown")

        p["feeState"] = fee
        if fee == "paid":
            p["status"] = "fee"
        elif legal and physical and shaped:
            p["status"] = "park"
        else:
            p["status"] = "unverified"
            p["statusWhy"] = "We can't confirm this is a park: " + \
                             "; ".join(why) + "."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="dir with baked.json + ep-*.geojson")
    ap.add_argument("--data", required=True, help="site data/ dir")
    ap.add_argument("--parking-from", help="places.json to reuse parking flags from")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    baked = load(os.path.join(args.raw, "baked.json"))["cache"]
    towns = Towns(load(os.path.join(args.data, "towns.geojson")))
    B = Builder(towns)
    print("  sources loaded", flush=True)

    # --- 1. CT DEEP state parks and forests ---------------------------
    for s in load(os.path.join(args.data, "state.json"))["parks"]:
        B.add(name=s["n"], type="state", subtype=s.get("t"), lat=s["lat"], lng=s["lng"],
              acres=s.get("a"), town=towns.find(s["lat"], s["lng"]))

    # --- 2. Hand-added places OSM is missing --------------------------
    add_path = os.path.join(args.data, "additions.json")
    if os.path.exists(add_path):
        for a in load(add_path).get("places") or []:
            B.add(name=a["n"], type=a.get("type", "preserve"), subtype=a.get("t"),
                  lat=a["lat"], lng=a["lng"], town=a.get("town") or towns.find(a["lat"], a["lng"]),
                  acres=a.get("a"), url=a.get("url"), fee=a.get("fee"),
                  agency=a.get("agency"), note=a.get("note"),
                  attrs={"trails": bool(a.get("trails")), "parking": bool(a.get("parking")),
                         "manual": True})

    # --- 3. Federal land ----------------------------------------------
    for n in load(os.path.join(args.data, "national.json"))["parks"]:
        B.add(name=n["n"], type="national", subtype=n.get("t"), lat=n["lat"], lng=n["lng"],
              town=n.get("town"), url=n.get("url"), acres=n.get("a"), fee=n.get("fee"),
              agency=n.get("agency"), note=n.get("note"))

    # --- 4. Other DEEP land: wildlife areas, hatcheries ---------------
    for s in baked.get("ctparks_stateextra_v1") or []:
        B.add(name=s["n"], type="state", subtype=LEGEND_LABEL.get(s["t"], s["t"]),
              lat=s["lat"], lng=s["lng"], acres=s.get("a"),
              town=towns.find(s["lat"], s["lng"]), agency="CT DEEP")

    # --- 5. Boat launches ---------------------------------------------
    for b in baked.get("ctparks_boat_v2") or []:
        if not b.get("n"):
            continue
        bits = []
        if b.get("w"):
            bits.append("On " + b["w"] + ".")
        kinds = []
        if re.match(r"y|1|true", str(b.get("trailer")), re.I or 0) if b.get("trailer") else False:
            kinds.append("trailer launch")
        if re.match(r"y|1|true", str(b.get("carry")), re.I) if b.get("carry") else False:
            kinds.append("car-top / carry-in")
        if kinds:
            bits.append("Suitable for " + " and ".join(kinds) + ".")
        B.add(name=b["n"], type="state", subtype="Boat Launch / Water Access",
              lat=b["lat"], lng=b["lng"], town=b.get("town") or towns.find(b["lat"], b["lng"]),
              url=b.get("url"), agency="CT DEEP", note=" ".join(bits) or None,
              attrs={"water": True, "waterName": b.get("w") or "Water access", "parking": True})

    # --- 6. Town parks -------------------------------------------------
    for m in baked.get("ctparks_municipal_v3") or []:
        town = towns.find(m["lat"], m["lng"])
        if not town:
            continue
        B.add(name=m["n"], type="town", lat=m["lat"], lng=m["lng"], town=town,
              acres=m.get("a"), url=m.get("w"))

    # --- 7. Town greens, rec grounds, forests --------------------------
    for m in baked.get("ctparks_landuse_v1") or []:
        town = towns.find(m["lat"], m["lng"])
        if not town:
            continue
        if EXCLUDE.search(m["n"]) and m["n"].lower() not in ALLOW:
            continue
        is_state = re.search(r"State Forest|State of Connecticut",
                             m["n"] + " " + (m.get("op") or ""), re.I)
        B.add(name=m["n"], type="state" if is_state else "town",
              subtype=LANDUSE_LABEL.get(m.get("k"), "Open Space"),
              lat=m["lat"], lng=m["lng"], town=town, acres=m.get("a"),
              agency=m.get("op") or None)

    # --- 8. Preserves and open space -----------------------------------
    for r in baked.get("ctparks_preserve_raw_v1") or []:
        op = r.get("op") or ""
        if OP_STATE.search(op) or OP_WATER.search(op):
            continue                                   # duplicate / permit-only
        if OP_FED.search(op):
            kind, label = "national", "National Park Service Land"
        elif OP_TOWN.search(op):
            kind, label = "town", "Town Open Space"
        elif OP_UNI.search(op):
            kind, label = "preserve", "University Land"
        elif OP_TRUST.search(op):
            kind, label = "preserve", "Land Trust Preserve"
        else:
            kind, label = "preserve", "Nature Preserve"
        name = r.get("n")
        if not name:
            if not op:
                continue
            name = ("Appalachian Trail Corridor" if kind == "national"
                    else re.sub(r",?\s*Inc\.?$", "", op) + " land")
        if EXCLUDE.search(name) and name.lower() not in ALLOW:
            continue
        town = towns.find(r["lat"], r["lng"])
        if not town:
            continue
        B.add(name=name, type=kind, subtype=label, lat=r["lat"], lng=r["lng"], town=town,
              url=r.get("w"), agency=op or None, fee="Free")

    # --- 9. Cemeteries --------------------------------------------------
    for m in baked.get("ctparks_cem_v2") or []:
        if TRIBAL_EXCLUDE.search(m["n"]):
            continue
        town = towns.find(m["lat"], m["lng"])
        if not town:
            continue
        historic = bool(BURYING_RE.search(m["n"]))
        B.add(name=m["n"], type="cemetery", lat=m["lat"], lng=m["lng"], town=town,
              acres=m.get("a"), url=m.get("w"),
              subtype="Historic Burying Ground" if historic else "Cemetery",
              attrs={"historic": historic})

    # --- 10. Historic site grounds -------------------------------------
    for m in baked.get("ctparks_museum_v1") or []:
        town = towns.find(m["lat"], m["lng"])
        if not town:
            continue
        B.add(name=m["n"], type="town", subtype="Historic Site Grounds",
              lat=m["lat"], lng=m["lng"], town=town, url=m.get("w"),
              agency=m.get("op") or None,
              note="Grounds are usually open and free to walk; admission to the "
                   "building may be charged. Check before visiting.",
              attrs={"historic": True})
    print(f"  {len(B.places):,} places from DEEP / NPS / OSM", flush=True)

    # --- 11. PAD-US, for land nothing else knows about -----------------
    by_name = defaultdict(list)
    for p in B.places:
        by_name[norm(p["name"])].append(p)
    added = 0
    pseen = set()
    for m in baked.get("ctparks_padusplaces_v1") or []:
        nm = m["n"].strip()
        k = f"{norm(nm)}|{round(m['lat'] * 200)}|{round(m['lng'] * 200)}"
        if k in pseen:
            continue
        pseen.add(k)
        if any(dist_m(p["lat"], p["lng"], m["lat"], m["lng"]) < 800
               for p in by_name.get(norm(nm), ())):
            continue
        if GENERIC_NAME.search(nm) or TRIBAL_EXCLUDE.search(nm):
            continue
        if EXCLUDE.search(nm) and nm.lower() not in ALLOW:
            continue
        town = towns.find(m["lat"], m["lng"])
        if not town:
            continue
        own, acc = m.get("own", "UNK"), m.get("acc", "UK")
        # Land owned by a private individual under an agricultural, ranch or
        # forest-stewardship easement is protected, but it is somebody's farm
        # or woodlot — there's no way in for anyone else, so by our own rule
        # it isn't public. Land trusts (NGO) stay: that's the Upland Pastures
        # case, where the owner does customarily allow walking.
        if own == "PVT":
            continue
        des = m.get("des") or ""
        if des in EASEMENT_DESIG and own not in ("SDC", "SPR", "SFW", "SDNR",
                                                 "OTHS", "CITY", "CNTY", "REG"):
            continue                                   # private land, restricted only
        if len(nm) < 3 or PARCEL_NAME.search(nm):
            continue                                   # a parcel, not a place
        by_permission = re.search(r"NGO|UNK", own) and acc in ("RA", "UK")
        if B.add(name=nm, type=PADUS_TYPE.get(own, "preserve"),
                 subtype=DESIG_WORD.get(m.get("des"), "Protected land"),
                 lat=m["lat"], lng=m["lng"], town=town, acres=m.get("a") or None,
                 agency=OWNER_WORD.get(own), fee="Open access" if acc == "OA" else None,
                 note=("Listed by USGS as restricted, which for land-trust and private "
                       "conservation land usually means open by the owner's permission "
                       "rather than by legal right. Check the owner's website or posted "
                       "signs.") if by_permission else None,
                 attrs={"officialAccess": ACCESS_WORD.get(acc, "Unknown"),
                        "officialOwner": OWNER_WORD.get(own, own), "fromPadus": True}):
            added += 1
    print(f"  +{added:,} gap-filling places from PAD-US = {len(B.places):,}", flush=True)

    removed = B.dedupe()
    print(f"  -{removed:,} cross-source duplicates = {len(B.places):,}", flush=True)

    # --- 12. What's actually there -------------------------------------
    fac = Grid(0.01)
    for row in baked.get("ctparks_fac_v1") or []:
        fac.add(row[0], row[1], (row[2], row[3]))
    wtr = Grid(0.02)
    for row in baked.get("ctparks_wtr_v1") or []:
        # Older files have 4 columns, newer ones carry the type tag too.
        wtr.add(row[0], row[1], (row[2], row[3], row[4] if len(row) > 4 else ""))
    parking = Grid(0.01)
    for row in baked.get("ctparks_park_v1") or []:
        parking.add(row[0], row[1], 1)

    # Parking never made it into the baked file (the point-layer bug), so
    # reuse the flags from a browser dump if one is supplied.
    park_flags = {}
    if args.parking_from and os.path.exists(args.parking_from):
        for x in load(args.parking_from)["places"]:
            if (x.get("attrs") or {}).get("parking"):
                park_flags[f"{norm(x['name'])}|{round(x['lat'] * 300)}|{round(x['lng'] * 300)}"] = True
        print(f"  {len(park_flags):,} parking flags reused", flush=True)

    coast_path = os.path.join(args.data, "coast.json")
    coast = Grid(0.01)
    if os.path.exists(coast_path):
        for pt in (load(coast_path).get("pts") or []):
            coast.add(pt[1], pt[0], 1)

    trail_cells = set(baked.get("ctparks_trailgrid_v2") or [])

    for p in B.places:
        r = park_radius_m(p)
        A = p["attrs"]
        sports = set()
        for _, (leis, sp) in fac.near(p["lat"], p["lng"], r + 140):
            if leis == "playground":
                A["playground"] = True
            elif leis == "dog_park":
                A["dogpark"] = True
            elif leis == "swimming_pool":
                A["pool"] = True; sports.add("swimming")
            elif leis == "beach_resort":
                A["beach"] = True
            elif leis == "track":
                sports.add("track")
            elif sp:
                for s in str(sp).split(";"):
                    lbl = SPORT_LABEL.get(s.strip())
                    if lbl:
                        sports.add(lbl)
            elif leis == "pitch":
                sports.add("ball field")
        if sports:
            A["sports"] = True
            A["sportList"] = sorted(sports)

        if parking.near(p["lat"], p["lng"], max(r, PARKING_RADIUS_M)):
            A["parking"] = True
        elif park_flags.get(f"{norm(p['name'])}|{round(p['lat'] * 300)}|{round(p['lng'] * 300)}"):
            A["parking"] = True

        best = None
        for d, (nm, rad, kind) in wtr.near(p["lat"], p["lng"], r + 2400):
            edge = d - (rad or 0)
            if edge < r + 150 and (best is None or edge < best[0]):
                best = (edge, nm, kind)
        if best:
            A["water"] = True
            A["waterName"] = best[1]
            # "Has water" is much less useful than knowing whether it's a
            # lake you can swim in or a river running past.
            k = (best[2] or "").lower()
            if k in ("lake", "reservoir", "pond", "basin"):
                A["waterType"] = "lake" if k != "reservoir" else "reservoir"
            elif k in ("river", "stream", "canal", "brook"):
                A["waterType"] = "river"
            elif k == "waterfall":
                A["waterType"] = "waterfall"
            elif re.search(r"\bfalls?\b", nm_lower(best[1])):
                A["waterType"] = "waterfall"
            elif re.search(r"\b(lake|pond|reservoir)\b", nm_lower(best[1])):
                A["waterType"] = "lake"
            elif re.search(r"\b(river|brook|creek|stream)\b", nm_lower(best[1])):
                A["waterType"] = "river"
        if p.get("town") in SHORE_TOWNS and coast.near(p["lat"], p["lng"], max(r + 250, 700)):
            A["water"] = True
            A["waterName"] = "Long Island Sound"
        if re.search(r"beach", p["name"], re.I):
            A["beach"] = True
        if A.get("beach"):
            A["water"] = True
        if HISTORIC_RE.search(p["name"]) or re.search(r"Historic", p.get("subtype") or "", re.I):
            A["historic"] = True

        # Trails. The cell span has to cover the park's own radius: capped
        # at 6 it only reached 999 m, so a 26,000-acre forest like Pachaug
        # was judged by a kilometre around its centroid and came out with
        # "no trails". 16 covers the 2,200 m radius cap.
        span = min(16, math.ceil((r + 150) / 111000 / TRAIL_CELL))
        i0 = math.floor(p["lat"] / TRAIL_CELL)
        j0 = math.floor(p["lng"] / TRAIL_CELL)
        found = False
        for i in range(i0 - span, i0 + span + 1):
            if found:
                break
            for j in range(j0 - span, j0 + span + 1):
                if i * 1000000 + (j + 500000) in trail_cells:
                    found = True
                    break
        if found:
            A["trails"] = True
        score_access(p)
    print("  attributes resolved", flush=True)

    # --- 13. Official PAD-US access ratings ----------------------------
    pad_grid = Grid(0.01)
    padus_geo = os.path.join(args.raw, "ep-padus.geojson")
    n_areas = 0
    if os.path.exists(padus_geo):
        for f in load(padus_geo)["features"]:
            pr = f.get("properties") or {}
            if not pr.get("Pub_Access"):
                continue
            g = f.get("geometry") or {}
            xs, ys = [], []

            def walk(c):
                if c and isinstance(c[0], (int, float)):
                    xs.append(c[0]); ys.append(c[1])
                else:
                    for i in c or []:
                        walk(i)
            walk(g.get("coordinates"))
            if not xs:
                continue
            pad_grid.add(sum(ys) / len(ys), sum(xs) / len(xs),
                         (pr.get("Pub_Access"), pr.get("Own_Name")))
            n_areas += 1

    tagged = 0
    for p in B.places:
        hits = pad_grid.near(p["lat"], p["lng"], PADUS_MATCH_M)
        if not hits:
            continue
        hits.sort(key=lambda t: t[0])
        acc, own = hits[0][1]
        word = ACCESS_WORD.get(acc, acc)
        if not word:
            continue
        A = p["attrs"]
        A["officialAccess"] = word
        if own:
            A["officialOwner"] = OWNER_WORD.get(own, own)
        if word == "Open":
            A["visitable"] = True
            A["accessNote"] = "Open to the public (USGS PAD-US)"
        elif word == "Closed":
            A["visitable"] = False
            A["accessNote"] = "Closed to public access (USGS PAD-US)"
        elif word == "Restricted":
            A["accessNote"] = "Restricted access (USGS PAD-US) — check before visiting"
        classify(p)
        tagged += 1
    print(f"  {n_areas:,} PAD-US areas -> ratings on {tagged:,} places", flush=True)

    # --- 14. Write ------------------------------------------------------
    # Only source facts are stored. Everything the map shows that can be
    # derived — access, its label and explanation, steward, kind, the
    # access note, visitable — is recomputed on load by the same classify()
    # and scoreAccess() used here. Deriving rather than storing keeps about
    # 2.9 MB out of the file and, more usefully, means changing the wording
    # or the rules is a code edit, not a rebuild.
    DERIVED = {"access", "accessLabel", "accessWhy", "steward", "kind",
               "statusWhy"}   # statusWhy is rebuilt in the browser from the flags
    DERIVED_ATTRS = {"accessNote", "visitable"}
    PADUS_NOTE = ("Listed by USGS as restricted, which for land-trust and private "
                  "conservation land usually means open by the owner's permission "
                  "rather than by legal right. Check the owner's website or posted "
                  "signs.")

    out = []
    dropped_closed = 0
    for p in B.places:
        if p.get("access") == "closed":
            dropped_closed += 1        # not somewhere you can visit
            continue
        rec = {}
        for k, v in p.items():
            if v is None or v == "" or v is False or k in DERIVED:
                continue
            if k == "attrs":
                a = {ak: av for ak, av in v.items()
                     if av not in (None, "", False) and ak not in DERIVED_ATTRS}
                if a:
                    rec["attrs"] = a
                continue
            if k == "note" and v == PADUS_NOTE:
                rec.setdefault("attrs", {})["byPermission"] = True
                continue
            rec[k] = v
        rec["lat"] = round(p["lat"], 5)
        rec["lng"] = round(p["lng"], 5)
        if isinstance(rec.get("acres"), float):
            rec["acres"] = round(rec["acres"], 1)
        out.append(rec)
    print(f"  dropped {dropped_closed:,} closed to the public", flush=True)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump({"built": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                   "places": out}, fh, separators=(",", ":"))
    print(f"\n  {len(out):,} places -> {args.out} "
          f"({os.path.getsize(args.out)/1024/1024:.2f} MB)")


if __name__ == "__main__":
    main()
