(function () {
  var abx = (window.abx = window.abx || {});
  function fromQuery() {
    try {
      var q = new URLSearchParams(location.search);
      var packed = q.get('abx');
      if (packed) {
        var b64 = packed.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); })));
      }
      // coordinate floor: enough for a deterministic piece opened bare from a gateway
      if (q.get('contract') && q.get('tokenId')) {
        return {
          chainId: Number(q.get('chainId') || 1),
          contractAddress: String(q.get('contract')).toLowerCase(),
          tokenId: String(q.get('tokenId')),
        };
      }
    } catch (e) {}
    return null;
  }
  abx.tokenData = window.abxTokenData || fromQuery();
  abx.__traits = null;
  abx.__done = false;
  /** The script reports its computed traits (script-defined features; captured at render). */
  abx.traits = function (t) {
    abx.__traits = t;
    try { document.dispatchEvent(new CustomEvent('abx:traits', {detail: t})); } catch (e) {}
    return t;
  };
  /** Output-complete — the capture point for the render effect. Optional (timeout fallback). */
  abx.done = function () {
    abx.__done = true;
    try { document.dispatchEvent(new CustomEvent('abx:done')); } catch (e) {}
  };
})();
