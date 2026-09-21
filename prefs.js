/* ============================================================
   EVERYPARK — WHAT THE BROWSER REMEMBERS

   One small store, shared by app.js and roadlayers.js, for the
   visitor's own choices about what the map draws. Nothing here
   is data and nothing here is ever sent anywhere: it is a
   handful of booleans in localStorage.

   It is deliberately its own file rather than a corner of
   app.js, because roadlayers.js needs it too and loads first.
   ============================================================ */

const EveryParkPrefs = (() => {
  const KEY = (typeof CONFIG !== "undefined" && CONFIG.mapLayers
               && CONFIG.mapLayers.remember) || "ep-layers-v1";

  // Private browsing, blocked site data and a few corporate policies
  // make localStorage throw on ACCESS, not just on write. Every read and
  // write here is wrapped, and the map has to work with the answer being
  // "nothing remembered" — which is also what a first visit looks like,
  // so there is no second code path to get wrong.
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch (e) { store = {}; }

  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  };

  return {
    // The visitor's choice if they have made one, otherwise the default
    // from config. Absent is not false: a layer nobody has touched must
    // fall back to what CONFIG.mapLayers says, or every default in there
    // would be dead the moment this file shipped.
    get(name, fallback) {
      return Object.prototype.hasOwnProperty.call(store, name)
        ? !!store[name] : !!fallback;
    },
    set(name, on) { store[name] = !!on; save(); },
    // For the road ranks, which are a set rather than one flag.
    getList(name, fallback) {
      const v = store[name];
      return Array.isArray(v) ? v : (fallback || []);
    },
    setList(name, arr) { store[name] = [...arr]; save(); },
    forget() { store = {}; try { localStorage.removeItem(KEY); } catch (e) {} }
  };
})();
