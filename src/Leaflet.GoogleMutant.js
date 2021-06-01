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

import { Google } from "./Leaflet.Google.js";

// 🍂class GridLayer.GoogleMutant
// 🍂extends GridLayer.Google
L.GridLayer.GoogleMutant = Google.extend({
	initialize: function () {
		this._lru = new LRUMap(100); // Tile LRU cache
		L.GridLayer.Google.prototype.initialize.apply(this, arguments);
	},
});

// 🍂factory gridLayer.googleMutant(options)
// Returns a new `GridLayer.GoogleMutant` given its options
L.gridLayer.googleMutant = function (options) {
	return new L.GridLayer.GoogleMutant(options);
};
