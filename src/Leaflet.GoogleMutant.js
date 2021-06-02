// GoogleMutant by Iván Sánchez Ortega <ivan@sanchezortega.es>

// Based on https://github.com/shramov/leaflet-plugins
// GridLayer like https://avinmathew.com/leaflet-and-google-maps/ , but using MutationObserver instead of jQuery

/*
"THE BEER-WARE LICENSE":
<ivan@sanchezortega.es> wrote this file. As long as you retain this notice you
can do whatever you want with this stuff. If we meet some day, and you think
this stuff is worth it, you can buy me a beer in return.
*/

import { LRUMap } from "./lru_map.js";

function waitForAPI(callback, context) {
	let checkCounter = 0,
		intervalId = null;

	intervalId = setInterval(function () {
		if (checkCounter >= 20) {
			clearInterval(intervalId);
			throw new Error("window.google not found after 10 seconds");
		}
		if (!!window.google && !!window.google.maps && !!window.google.maps.Map) {
			clearInterval(intervalId);
			callback.call(context);
		}
		++checkCounter;
	}, 500);
}

// 🍂class GridLayer.GoogleMutant
// 🍂extends GridLayer
L.GridLayer.GoogleMutant = L.GridLayer.extend({
	options: {
		maxZoom: 21, // can be 23, but ugly if more than maxNativeZoom
		// 🍂option type: String = 'roadmap'
		// Google's map type. Valid values are 'roadmap', 'satellite' or 'terrain'. 'hybrid' is not really supported.
		type: "roadmap",
		maxNativeZoom: 21,
	},

	initialize: function (options) {
		L.GridLayer.prototype.initialize.call(this, options);

		// Couple data structures indexed by tile key
		this._tileCallbacks = {}; // Callbacks for promises for tiles that are expected
		this._lru = new LRUMap(100); // Tile LRU cache
		this._handlers = { tileunload: this._onTileunload };

		this._boundOnMutatedImage = this._onMutatedImage.bind(this);
	},

	onAdd: function (map) {
		this.on(this._handlers);
		L.GridLayer.prototype.onAdd.call(this, map);
		this._initMutantContainer();

		// Attribution and logo nodes are not mutated a second time if the
		// mutant is removed and re-added to the map, hence they are
		// not cleaned up on layer removal, so they can be added here.
		if (this._logoContainer) {
			map._controlCorners.bottomleft.appendChild(this._logoContainer);
		}
		if (this._attributionContainer) {
			map._controlCorners.bottomright.appendChild(this._attributionContainer);
		}

		waitForAPI(() => {
			if (!this._map) {
				return;
			}
			this._initMutant();

			//handle layer being added to a map for which there are no Google tiles at the given zoom
			google.maps.event.addListenerOnce(this._mutant, "idle", () => {
				if (!this._map) {
					return;
				}
				this._checkZoomLevels();
				this._mutantIsReady = true;
			});
		});
	},

	onRemove: function (map) {
		this.off(this._handlers);
		L.GridLayer.prototype.onRemove.call(this, map);
		this._observer.disconnect();
		map._container.removeChild(this._mutantContainer);
		if (this._logoContainer) {
			L.DomUtil.remove(this._logoContainer);
		}
		if (this._attributionContainer) {
			L.DomUtil.remove(this._attributionContainer);
		}
		if (this._mutant) {
			google.maps.event.clearListeners(this._mutant, "idle");
		}
	},

	_onTileunload: function (ev) { // cleanup _tileCallbacks
		const key = this._tileCoordsToKey(ev.coords);
		delete this._tileCallbacks[key];
	},

	// 🍂method addGoogleLayer(name: String, options?: Object): this
	// Adds layer with the given name and options to the google Map instance.
	// `name`: one of the google maps API layers, with it's constructor available in `google.maps` object.
	// currently following values supported: 'TrafficLayer', 'TransitLayer', 'BicyclingLayer'.
	// `options`: see https://developers.google.com/maps/documentation/javascript/reference/map
	addGoogleLayer: function (googleLayerName, options) {
		if (!this._subLayers) this._subLayers = {};
		this.whenReady(() => {
			var Constructor = google.maps[googleLayerName];
			var googleLayer = new Constructor(options);
			googleLayer.setMap(this._mutant);
			this._subLayers[googleLayerName] = googleLayer;
		});
		return this;
	},

	// 🍂method removeGoogleLayer(name: String): this
	// Removes layer with the given name from the google Map instance.
	removeGoogleLayer: function (googleLayerName) {
		this.whenReady(() => {
			var googleLayer = this._subLayers && this._subLayers[googleLayerName];
			if (googleLayer) {
				googleLayer.setMap(null);
				delete this._subLayers[googleLayerName];
			}
		});
		return this;
	},

	_initMutantContainer: function () {
		if (!this._mutantContainer) {
			this._mutantContainer = L.DomUtil.create(
				"div",
				"leaflet-google-mutant leaflet-top leaflet-left"
			);
			this._mutantContainer.id = "_MutantContainer_" + L.Util.stamp(this._mutantContainer);
			this._mutantContainer.style.pointerEvents = "none";
			this._mutantContainer.style.visibility = "hidden";

			L.DomEvent.off(this._mutantContainer);
		}
		this._map.getContainer().appendChild(this._mutantContainer);

		this.setOpacity(this.options.opacity);
		const style = this._mutantContainer.style;
		if (this._map.options.zoomSnap < 1) {
			// Fractional zoom needs a bigger mutant container in order to load more (smaller) tiles
			style.width = "180%";
			style.height = "180%";
		} else {
			style.width = "100%";
			style.height = "100%";
		}
		style.zIndex = -1;

		this._attachObserver(this._mutantContainer);
	},

	_initMutant: function () {
		if (this._mutant) {
			return;
		}

		var map = new google.maps.Map(this._mutantContainer, {
			center: { lat: 0, lng: 0 },
			zoom: 0,
			tilt: 0,
			mapTypeId: this.options.type,
			disableDefaultUI: true,
			keyboardShortcuts: false,
			draggable: false,
			disableDoubleClickZoom: true,
			scrollwheel: false,
			styles: this.options.styles || {},
			backgroundColor: "transparent",
		});

		this._mutant = map;

		this._update();

		// 🍂event spawned
		// Fired when the mutant has been created.
		this.fire("spawned", { mapObject: map });

		this._waitControls();
		this.once('controls_ready', this._setupAttribution);
	},

	_attachObserver: function _attachObserver(node) {
		if (!this._observer) this._observer = new MutationObserver(this._onMutations.bind(this));

		// pass in the target node, as well as the observer options
		this._observer.observe(node, { childList: true, subtree: true });

		// if we are reusing an old _mutantContainer, we must manually detect
		// all existing tiles in it
		Array.prototype.forEach.call(node.querySelectorAll("img"), this._boundOnMutatedImage);
	},

	_waitControls: function () {
		const id = setInterval(() => {
			const layoutManager = this._mutant.__gm.layoutManager;
			if (!layoutManager) { return; }
			clearInterval(id);
			let positions;
			// iterate through obfuscated key names to find positions set (atm: layoutManager.o)
			Object.keys(layoutManager).forEach(function(key) {
				const el = layoutManager[key];
				if (el.get) {
					if (el.get(1) instanceof Node) {
						positions = el;
					}
				}
			});
			// 🍂event controls_ready
			// Fired when controls positions get available (passed in `positions` property).
			this.fire("controls_ready", { positions });
		}, 50);
	},

	_setupAttribution: function (ev) {
		// https://developers.google.com/maps/documentation/javascript/reference/control#ControlPosition
		const pos = google.maps.ControlPosition;
		const ctr = this._attributionContainer = ev.positions.get(pos.BOTTOM_RIGHT);
		L.DomUtil.addClass(ctr, "leaflet-control leaflet-control-attribution");
		L.DomEvent.disableClickPropagation(ctr);
		ctr.style.height = "14px";
		this._map._controlCorners.bottomright.appendChild(ctr);

		this._logoContainer = ev.positions.get(pos.BOTTOM_LEFT);
		this._logoContainer.style.pointerEvents = "auto";
		this._map._controlCorners.bottomleft.appendChild(this._logoContainer);
	},

	_onMutations: function _onMutations(mutations) {
		for (var i = 0; i < mutations.length; ++i) {
			var mutation = mutations[i];
			for (var j = 0; j < mutation.addedNodes.length; ++j) {
				var node = mutation.addedNodes[j];

				if (node instanceof HTMLImageElement) {
					this._onMutatedImage(node);
				} else if (node instanceof HTMLElement) {
					Array.prototype.forEach.call(
						node.querySelectorAll("img"),
						this._boundOnMutatedImage
					);
				}
			}
		}
	},

	// Only images which 'src' attrib match this will be considered for moving around.
	// Looks like some kind of string-based protobuf, maybe??
	// Only the roads (and terrain, and vector-based stuff) match this pattern
	_roadRegexp: /!1i(\d+)!2i(\d+)!3i(\d+)!/,

	// On the other hand, raster imagery matches this other pattern
	_satRegexp: /x=(\d+)&y=(\d+)&z=(\d+)/,

	// On small viewports, when zooming in/out, a static image is requested
	// This will not be moved around, just removed from the DOM.
	_staticRegExp: /StaticMapService\.GetMapImage/,

	_roadmapSubstr: [
		"!2sRoadmap!",
		"!2sNonRoadmap!",       // roadmap + BicyclingLayer
		"!2sTransitFocused!",   // roadmap + TransitLayer
		"!2sTerrain!"
	],

	_isRoadmap: function (url) {
		return this._roadmapSubstr.some(function (substr) {
			return url.search(substr) !== -1;
		});
	},

	_onMutatedImage: function _onMutatedImage(imgNode) {
		let coords;
		let match = imgNode.src.match(this._roadRegexp);
		let sublayer;

		if (match) {
			coords = {
				z: match[1],
				x: match[2],
				y: match[3],
			};
			if (this._isRoadmap(imgNode.src)) {
				sublayer = 0;
			} else if (imgNode.src.search("!2sRoadmapSatellite!") !== -1) {
				sublayer = 1; // hybrid
			} else {
				sublayer = 2; // other (e.g. kml)
			}
		} else {
			match = imgNode.src.match(this._satRegexp);
			if (match) {
				coords = {
					x: match[1],
					y: match[2],
					z: match[3],
				};
			}
			sublayer = 0;
		}

		if (coords) {
			const key = this._tileCoordsToKey(coords);

			// Cache img so it can also be used in subsequent tile requests
			const key2 = key + "/" + sublayer;
			this._lru.set(key2, imgNode);

			if (this._tileCallbacks[key]) {
				this._tileCallbacks[key].forEach(callback => callback(imgNode, sublayer));
			} else {
				const tile = this._tiles[key];
				if (tile) {
					this._updateTile(tile, imgNode, sublayer);
				}
			}
		}
	},

	_updateTile: function (tile, imgNode, sublayer) {
		const clonedImgNode = this._clone(imgNode, sublayer);
		const oldImg = tile.el.querySelector(`img[data-sublayer="${sublayer}"]`);
		if (oldImg) {
			tile.el.replaceChild(clonedImgNode, oldImg);
		} else {
			tile.el.appendChild(clonedImgNode);
		}
	},

	createTile: function (coords, done) {
		const key = this._tileCoordsToKey(coords),
			tileContainer = L.DomUtil.create("div");

		tileContainer.style.textAlign = "left";
		const loaded = this._imagesPerTile.slice(); // track already loaded sublayers
		loaded.forEach(function (_, i) {
			const key2 = key + "/" + i,
				imgNode = this._lru.get(key2);
			if (imgNode) {
				const clonedImgNode = this._clone(imgNode, i);
				clonedImgNode._fromCache = true; // for debug
				tileContainer.appendChild(clonedImgNode);
				loaded[i] = true;
			}
		}, this);
		if (loaded.indexOf(false) === -1) {
			L.Util.requestAnimFrame(done.bind(this, null, tileContainer));
		} else {
			this._tileCallbacks[key] = this._tileCallbacks[key] || [];
			this._tileCallbacks[key].push(function (imgNode, sublayer) {
				if (loaded[sublayer]) {
					// image can first came from our cache, then updated by google map
					this._updateTile(this._tiles[key], imgNode, sublayer);
					return;
				}
				const clonedImgNode = this._clone(imgNode, sublayer);
				tileContainer.appendChild(clonedImgNode);
				loaded[sublayer] = true;
				if (loaded.indexOf(false) === -1) {
					done(null, tileContainer);
					delete this._tileCallbacks[key];
				}
			}.bind(this));
		}
		return tileContainer;
	},


	_clone: function (imgNode, sublayer) {
		const clonedImgNode = imgNode.cloneNode(true);
		clonedImgNode.style.position = "absolute";
		clonedImgNode.style.zIndex = sublayer;
		clonedImgNode.dataset.sublayer = sublayer;
		return clonedImgNode;
	},

	_checkZoomLevels: function () {
		//setting the zoom level on the Google map may result in a different zoom level than the one requested
		//(it won't go beyond the level for which they have data).
		const zoomLevel = this._map.getZoom(),
			gMapZoomLevel = this._mutant.getZoom();

		if (!zoomLevel || !gMapZoomLevel) return;

		if (
			gMapZoomLevel !== zoomLevel || //zoom levels are out of sync, Google doesn't have data
			gMapZoomLevel > this.options.maxNativeZoom
		) {
			//at current location, Google does have data (contrary to maxNativeZoom)
			//Update maxNativeZoom
			this._setMaxNativeZoom(gMapZoomLevel);
		}
	},

	_setMaxNativeZoom: function (zoomLevel) {
		if (zoomLevel !== this.options.maxNativeZoom) {
			this.options.maxNativeZoom = zoomLevel;
			this._resetView();
		}
	},

	_update: function (center) {
		if (!this._mutant) { return; }

		// zoom level check needs to happen before super's implementation (tile addition/creation)
		// otherwise tiles may be missed if maxNativeZoom is not yet correctly determined

		center = center || this._map.getCenter();
		const _center = new google.maps.LatLng(center.lat, center.lng),
			zoom = Math.round(this._map.getZoom()),
			mutantZoom = this._mutant.getZoom();

		this._mutant.setCenter(_center);

		//ignore fractional zoom levels
		if (zoom !== mutantZoom) {
			this._mutant.setZoom(zoom);

			if (this._mutantIsReady) this._checkZoomLevels();
			//else zoom level check will be done later by 'idle' handler
		}

		this._setImagesPerTile();
		L.GridLayer.prototype._update.call(this, center);
	},

	_setImagesPerTile: function () {
		this._imagesPerTile = this.options.type === "hybrid" ? [false, false] : [false];
		if (this._subLayers && this._subLayers.KmlLayer) {
			this._imagesPerTile[2] = false;
		}
	},

	// @method whenReady(fn: Function, context?: Object): this
	// Runs the given function `fn` when the mutant gets initialized, or immediately
	// if it's already initialized, optionally passing a function context.
	whenReady: function (callback, context) {
		if (this._mutant) {
			callback.call(context || this, { target: this });
		} else {
			this.on("spawned", callback, context);
		}
		return this;
	},
});

// 🍂factory gridLayer.googleMutant(options)
// Returns a new `GridLayer.GoogleMutant` given its options
L.gridLayer.googleMutant = function (options) {
	return new L.GridLayer.GoogleMutant(options);
};
