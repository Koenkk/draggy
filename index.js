/**
 * Simple draggable component
 *
 * @module draggy
 */


//work with css
const css = require('mucss/css');
const parseCSSValue = require('mucss/parse-value');
const selection = require('mucss/selection');
const offsets = require('mucss/offset');
const getTranslate = require('mucss/translate');
const intersect = require('intersects');
const isFixed = require('mucss/is-fixed');

//events
const on = require('emmy/on');
const off = require('emmy/off');
const emit = require('emmy/emit');
const Emitter = require('events');
const getClientX = require('get-client-xy').x;
const getClientY = require('get-client-xy').y;

//utils
const isArray = require('mutype/is-array');
const isNumber = require('mutype/is-number');
const isString = require('mutype/is-string');
const isFn = require('mutype/is-fn');
const defineState = require('define-state');
const extend = require('xtend/mutable');
const round = require('mumath/round');
const between = require('mumath/clamp');
const loop = require('mumath/mod');
const getUid = require('get-uid');
const inherits =  require('inherits');


const win = window, doc = document, root = doc.documentElement;


/**
 * Draggable controllers associated with elements.
 *
 * Storing them on elements is
 * - leak-prone,
 * - pollutes element’s namespace,
 * - requires some artificial key to store,
 * - unable to retrieve controller easily.
 *
 * That is why weakmap.
 */
const draggableCache = Draggable.cache = new WeakMap;



/**
 * Make an element draggable.
 *
 * @constructor
 *
 * @param {HTMLElement} target An element whether in/out of DOM
 * @param {Object} options An draggable options
 *
 * @return {HTMLElement} Target element
 */
function Draggable(target, options) {
	if (!(this instanceof Draggable)) {
		return new Draggable(target, options);
	}

	var self = this;

	//ignore existing instance
	var instance = draggableCache.get(target);
	if (instance) {
		instance.state = 'reset';

		//take over options
		extend(instance, options);

		instance.update();

		return instance;
	}

	else {
		//get unique id for instance
		//needed to track event binders
		self.id = getUid();
		self._ns = '.draggy_' + self.id;

		//save element passed
		self.element = target;

		draggableCache.set(target, self);
	}

	//define state behaviour
	defineState(self, 'state', self.state);

	//preset handles
	self.currentHandles = [];

	//take over options
	extend(self, options);

	//define handle
	if (self.handle === undefined) {
		self.handle = self.element;
	}

	//setup droppable
	if (self.droppable) {
		self.initDroppable();
	}

	//try to calc out basic limits
	self.update();

	//go to initial state
	self.state = 'idle';
}


/** Inherit draggable from Emitter */
inherits(Draggable, Emitter);


//enable css3 by default
Draggable.prototype.css3 = true;

//both axes by default
Draggable.prototype.axis = null;


/** Init droppable "plugin" */
Draggable.prototype.initDroppable = function () {
	var self = this;

	on(self, 'dragstart', function () {
		var self = this;
		self.dropTargets = q(self.droppable);
	});

	on(self, 'drag', function () {
		var self = this;

		if (!self.dropTargets) {
			return;
		}

		var selfRect = offsets(self.element);

		self.dropTargets.forEach(function (dropTarget) {
			var targetRect = offsets(dropTarget);

			if (intersect(selfRect, targetRect, self.droppableTolerance)) {
				if (self.droppableClass) {
					dropTarget.classList.add(self.droppableClass);
				}
				if (!self.dropTarget) {
					self.dropTarget = dropTarget;

					emit(self, 'dragover', dropTarget);
					emit(dropTarget, 'dragover', self);
				}
			}
			else {
				if (self.dropTarget) {
					emit(self, 'dragout', dropTarget);
					emit(dropTarget, 'dragout', self);

					self.dropTarget = null;
				}
				if (self.droppableClass) {
					dropTarget.classList.remove(self.droppableClass);
				}
			}
		});
	});

	on(self, 'dragend', function () {
		var self = this;

		//emit drop, if any
		if (self.dropTarget) {
			emit(self.dropTarget, 'drop', self);
			emit(self, 'drop', self.dropTarget);
			self.dropTarget.classList.remove(self.droppableClass);
			self.dropTarget = null;
		}
	});
};


/**
 * Draggable behaviour
 * @enum {string}
 * @default is 'idle'
 */
Draggable.prototype.state = {
	//idle
	_: {
		before: function () {
			var self = this;

			self.element.classList.add('draggy-idle');

			//emit drag evts on element
			emit(self.element, 'idle', null, true);
			self.emit('idle');

			//reset keys
			self.ctrlKey = false;
			self.shiftKey = false;
			self.metaKey = false;
			self.altKey = false;

			//reset movement params
			self.movementX = 0;
			self.movementY = 0;
			self.deltaX = 0;
			self.deltaY = 0;

			on(doc, 'mousedown' + self._ns + ' touchstart' + self._ns, function (e) {
				//ignore non-draggy events
				if (!e.draggies) {
					return;
				}

				//ignore dragstart for not registered draggies
				if (e.draggies.indexOf(self) < 0) {
					return;
				}

				//if target is focused - ignore drag
				//FIXME: detect focused by whitelist of tags, name supposition may be wrong (idk, form elements have names, so likely to be focused by click)
				if (e.target.name !== undefined) {
					return;
				}

				//multitouch has multiple starts
				self.setTouch(e);

				//update movement params
				self.update(e);

				//go to threshold state
				self.state = 'threshold';
			});
		},
		after: function () {
			var self = this;

			self.element.classList.remove('draggy-idle');

			off(doc, self._ns);

			//set up tracking
			if (self.release) {
				self._trackingInterval = setInterval(function (e) {
					var now = Date.now();
					var elapsed = now - self.timestamp;

					//get delta movement since the last track
					var dX = self.prevX - self.frame[0];
					var dY = self.prevY - self.frame[1];
					self.frame[0] = self.prevX;
					self.frame[1] = self.prevY;

					var delta = Math.sqrt(dX * dX + dY * dY);

					//get speed as average of prev and current (prevent div by zero)
					var v = Math.min(self.velocity * delta / (1 + elapsed), self.maxSpeed);
					self.speed = 0.8 * v + 0.2 * self.speed;

					//get new angle as a last diff
					//NOTE: vector average isn’t the same as speed scalar average
					self.angle = Math.atan2(dY, dX);

					self.emit('track');

					return self;
				}, self.framerate);
			}
		}
	},

	threshold: {
		before: function () {
			var self = this;

			//ignore threshold state, if threshold is none
			if (isZeroArray(self.threshold)) {
				self.state = 'drag';
				return;
			}

			self.element.classList.add('draggy-threshold');

			//emit drag evts on element
			self.emit('threshold');
			emit(self.element, 'threshold');

			//listen to doc movement
			on(doc, 'touchmove' + self._ns + ' mousemove' + self._ns, function (e) {
				e.preventDefault();

				//compare movement to the threshold
				var clientX = getClientX(e, self.touchIdx);
				var clientY = getClientY(e, self.touchIdx);
				var difX = self.prevMouseX - clientX;
				var difY = self.prevMouseY - clientY;

				if (difX < self.threshold[0] || difX > self.threshold[2] || difY < self.threshold[1] || difY > self.threshold[3]) {
					self.update(e);
					self.state = 'drag';
				}
			});
			on(doc, 'mouseup' + self._ns + ' touchend' + self._ns + '', function (e) {
				e.preventDefault();

				//forget touches
				self.resetTouch();

				self.state = 'idle';
			});
		},

		after: function () {
			var self = this;

			self.element.classList.remove('draggy-threshold');

			off(doc, self._ns);
		}
	},

	drag: {
		before: function () {
			var self = this;

			//reduce dragging clutter
			selection.disable(root);

			self.element.classList.add('draggy-drag');

			//emit drag evts on element
			self.emit('dragstart');
			emit(self.element, 'dragstart', null, true);

			//emit drag events on self
			self.emit('drag');
			emit(self.element, 'drag', null, true);

			//stop drag on leave
			on(doc, 'touchend' + self._ns + ' mouseup' + self._ns + ' mouseleave' + self._ns, function (e) {
				e.preventDefault();

				//forget touches - dragend is called once
				self.resetTouch();

				//manage release movement
				if (self.speed > 1) {
					self.state = 'release';
				}

				else {
					self.state = 'idle';
				}
			});

			//move via transform
			on(doc, 'touchmove' + self._ns + ' mousemove' + self._ns, function (e) {
				self.drag(e);
			});
		},

		after: function () {
			var self = this;

			//enable document interactivity
			selection.enable(root);

			self.element.classList.remove('draggy-drag');

			//emit dragend on element, this
			self.emit('dragend');
			emit(self.element, 'dragend', null, true);

			//unbind drag events
			off(doc, self._ns);

			clearInterval(self._trackingInterval);
		}
	},

	release: {
		before: function () {
			var self = this;

			self.element.classList.add('draggy-release');

			//enter animation mode
			clearTimeout(self._animateTimeout);

			//set proper transition
			css(self.element, {
				'transition': (self.releaseDuration) + 'ms ease-out ' + (self.css3 ? 'transform' : 'position')
			});

			//plan leaving anim mode
			self._animateTimeout = setTimeout(function () {
				self.state = 'idle';
			}, self.releaseDuration);


			//calc target point & animate to it
			self.move(
				self.prevX + self.speed * Math.cos(self.angle),
				self.prevY + self.speed * Math.sin(self.angle)
			);

			self.speed = 0;
			self.emit('track');
		},

		after: function () {
			var self = this;

			self.element.classList.remove('draggy-release');

			css(this.element, {
				'transition': null
			});
		}
	},

	reset: function () {
		var self = this;

		self.currentHandles.forEach(function (handle) {
			off(handle, self._ns);
		});

		clearTimeout(self._animateTimeout);

		off(doc, self._ns);
		off(self.element, self._ns);

		return '_';
	}
};


/** Drag handler. Needed to provide drag movement emulation via API */
Draggable.prototype.drag = function (e) {
	var self = this;

	e.preventDefault();

	var mouseX = getClientX(e, self.touchIdx),
		mouseY = getClientY(e, self.touchIdx);

	//calc mouse movement diff
	var diffMouseX = mouseX - self.prevMouseX,
		diffMouseY = mouseY - self.prevMouseY;

	//absolute mouse coordinate
	var mouseAbsX = mouseX,
		mouseAbsY = mouseY;

	//if we are not fixed, our absolute position is relative to the doc
	if (!self._isFixed) {
		mouseAbsX += win.pageXOffset;
		mouseAbsY += win.pageYOffset;
	}

	//calc sniper offset, if any
	if (e.ctrlKey || e.metaKey) {
		self.sniperOffsetX += diffMouseX * self.sniperSlowdown;
		self.sniperOffsetY += diffMouseY * self.sniperSlowdown;
	}

	//save refs to the meta keys
	self.ctrlKey = e.ctrlKey;
	self.shiftKey = e.shiftKey;
	self.metaKey = e.metaKey;
	self.altKey = e.altKey;

	//calc movement x and y
	//take absolute placing as it is the only reliable way (2x proved)
	var x = (mouseAbsX - self.initOffsetX) - self.innerOffsetX - self.sniperOffsetX,
		y = (mouseAbsY - self.initOffsetY) - self.innerOffsetY - self.sniperOffsetY;

	//move element
	self.move(x, y);

	//save prevClientXY for calculating diff
	self.prevMouseX = mouseX;
	self.prevMouseY = mouseY;

	//emit drag
	self.emit('drag');
	emit(self.element, 'drag', null, true);
};


/** Current number of draggable touches */
var touches = 0;


/** Manage touches */
Draggable.prototype.setTouch = function (e) {
	if (!e.touches || this.isTouched()) return this;

	//current touch index
	this.touchIdx = touches;
	touches++;

	return this;
};
Draggable.prototype.resetTouch = function () {
	touches = 0;
	this.touchIdx = null;

	return this;
};
Draggable.prototype.isTouched = function () {
	return this.touchIdx !== null;
};


/** Index to fetch touch number from event */
Draggable.prototype.touchIdx = null;


/**
 * Update movement limits.
 * Refresh self.withinOffsets and self.limits.
 */
Draggable.prototype.update = function (e) {
	var self = this;

	self._isFixed = isFixed(self.element);

	//enforce abs position
	if (!self.css3) {
		css(this.element, 'position', 'absolute');
	}

	//update handles
	self.currentHandles.forEach(function (handle) {
		off(handle, self._ns);
	});

	var cancelEls = q(self.cancel);

	self.currentHandles = q(self.handle);

	self.currentHandles.forEach(function (handle) {
		on(handle, 'mousedown' + self._ns + ' touchstart' + self._ns, function (e) {
			//mark event as belonging to the draggy
			if (!e.draggies) {
				e.draggies = [];
			}

			//ignore draggies containing other draggies
			if (e.draggies.some(function (draggy) {
				return self.element.contains(draggy.element);
			})) {
				return;
			}
			//ignore events happened within cancelEls
			if (cancelEls.some(function (cancelEl) {
				return cancelEl.contains(e.target);
			})) {
				return;
			}

			//register draggy
			e.draggies.push(self);
		});
	});

	//update limits
	self.updateLimits();

	//preset inner offsets
	self.innerOffsetX = self.pin[0];
	self.innerOffsetY = self.pin[1];

	var selfClientRect = self.element.getBoundingClientRect();

	//if event passed - update acc to event
	if (e) {
		//take last mouse position from the event
		self.prevMouseX = getClientX(e, self.touchIdx);
		self.prevMouseY = getClientY(e, self.touchIdx);

		//if mouse is within the element - take offset normally as rel displacement
		self.innerOffsetX = -selfClientRect.left + getClientX(e, self.touchIdx);
		self.innerOffsetY = -selfClientRect.top + getClientY(e, self.touchIdx);
	}
	//if no event - suppose pin-centered event
	else {
		//take mouse position & inner offset as center of pin
		var pinX = (self.pin[0] + self.pin[2] ) * 0.5;
		var pinY = (self.pin[1] + self.pin[3] ) * 0.5;
		self.prevMouseX = selfClientRect.left + pinX;
		self.prevMouseY = selfClientRect.top + pinY;
		self.innerOffsetX = pinX;
		self.innerOffsetY = pinY;
	}

	//set initial kinetic props
	self.speed = 0;
	self.amplitude = 0;
	self.angle = 0;
	self.timestamp = +new Date();
	self.frame = [self.prevX, self.prevY];

	//set sniper offset
	self.sniperOffsetX = 0;
	self.sniperOffsetY = 0;
};

/**
 * Update limits only from current position
 */
Draggable.prototype.updateLimits = function () {
	var self = this;

	//initial translation offsets
	var initXY = self.getCoords();

	//calc initial coords
	self.prevX = initXY[0];
	self.prevY = initXY[1];
	self.initX = initXY[0];
	self.initY = initXY[1];

	//container rect might be outside the vp, so calc absolute offsets
	//zero-position offsets, with translation(0,0)
	var selfOffsets = offsets(self.element);

	self.initOffsetX = selfOffsets.left - self.prevX;
	self.initOffsetY = selfOffsets.top - self.prevY;
	self.offsets = selfOffsets;

	//handle parent case
	var within = self.within;
	if (self.within === 'parent') {
		within = self.element.parentNode;
	}
	within = within || doc;

	//absolute offsets of a container
	var withinOffsets = offsets(within);
	if (within === win && self._isFixed) {
		withinOffsets.top -= win.pageYOffset;
		withinOffsets.left -= win.pageXOffset;
		withinOffsets.bottom -= win.pageYOffset;
		withinOffsets.right -= win.pageXOffset;
	}
	self.withinOffsets = withinOffsets;

	//calculate movement limits - pin width might be wider than constraints
	self.overflowX = self.pin.width - withinOffsets.width;
	self.overflowY = self.pin.height - withinOffsets.height;
	self.limits = {
		left: withinOffsets.left - self.initOffsetX - self.pin[0] - (self.overflowX < 0 ? 0 : self.overflowX),
		top: withinOffsets.top - self.initOffsetY - self.pin[1] - (self.overflowY < 0 ? 0 : self.overflowY),
		right: self.overflowX > 0 ? 0 : withinOffsets.right - self.initOffsetX - self.pin[2],
		bottom: self.overflowY > 0 ? 0 : withinOffsets.bottom - self.initOffsetY - self.pin[3]
	};
};

/**
 * Update info regarding of movement
 */
Draggable.prototype.updateInfo = function (x, y) {
	var self = this;

	//provide delta from prev state
	self.deltaX = x - self.prevX;
	self.deltaY = y - self.prevY;

	//save prev coords to use as a start point next time
	self.prevX = x;
	self.prevY = y;

	//provide movement delta from initial state
	self.movementX = x - self.initX;
	self.movementY = y - self.initY;

}


/**
 * Way of placement:
 * - css3 === false (slower but more precise and cross-browser)
 * - css3 === true (faster but may cause blurs on linux systems)
 */
Draggable.prototype.getCoords = function () {
	if (!this.css3) {
		// return [this.element.offsetLeft, this.element.offsetTop];
		return [parseCSSValue(css(this.element,'left')), parseCSSValue(css(this.element, 'top'))];
	}
	else {
		return getTranslate(this.element).slice(0, 2) || [0,0];
	}
};
Draggable.prototype.setCoords = function (x, y) {
	if (this.css3) {
		if (x == null) x = this.prevX;
		if (y == null) y = this.prevY;

		x = round(x, this.precision);
		y = round(y, this.precision);

		css(this.element, 'transform', ['translate3d(', x, 'px,', y, 'px, 0)'].join(''));

		this.updateInfo(x, y);
	}
	else {
		if (x == null) x = this.prevX;
		if (y == null) y = this.prevY;

		x = round(x, this.precision);
		y = round(y, this.precision);

		css(this.element, {
			left: x,
			top: y
		});

		//update movement info
		this.updateInfo(x, y);
	}
};


/**
 * Restricting container
 * @type {Element|object}
 * @default doc.documentElement
 */
Draggable.prototype.within = doc;


/** Handle to drag */
Draggable.prototype.handle;


Object.defineProperties(Draggable.prototype, {
	/**
	 * Which area of draggable should not be outside the restriction area.
	 * @type {(Array|number)}
	 * @default [0,0,this.element.offsetWidth, this.element.offsetHeight]
	 */
	pin: {
		set: function (value) {
			if (isArray(value)) {
				if (value.length === 2) {
					this._pin = [value[0], value[1], value[0], value[1]];
				} else if (value.length === 4) {
					this._pin = value;
				}
			}

			else if (isNumber(value)) {
				this._pin = [value, value, value, value];
			}

			else {
				this._pin = value;
			}

			//calc pin params
			this._pin.width = this._pin[2] - this._pin[0];
			this._pin.height = this._pin[3] - this._pin[1];
		},

		get: function () {
			if (this._pin) return this._pin;

			//returning autocalculated pin, if private pin is none
			var pin = [0,0, this.offsets.width, this.offsets.height];
			pin.width = this.offsets.width;
			pin.height = this.offsets.height;
			return pin;
		}
	},

	/** Avoid initial mousemove */
	threshold: {
		set: function (val) {
			if (isNumber(val)) {
				this._threshold = [-val*0.5, -val*0.5, val*0.5, val*0.5];
			} else if (val.length === 2) {
				//Array(w,h)
				this._threshold = [-val[0]*0.5, -val[1]*0.5, val[0]*0.5, val[1]*0.5];
			} else if (val.length === 4) {
				//Array(x1,y1,x2,y2)
				this._threshold = val;
			} else if (isFn(val)) {
				//custom val funciton
				this._threshold = val();
			} else {
				this._threshold = [0,0,0,0];
			}
		},

		get: function () {
			return this._threshold || [0,0,0,0];
		}
	}
});



/**
 * For how long to release movement
 *
 * @type {(number|false)}
 * @default false
 * @todo
 */
Draggable.prototype.release = false;
Draggable.prototype.releaseDuration = 500;
Draggable.prototype.velocity = 1000;
Draggable.prototype.maxSpeed = 250;
Draggable.prototype.framerate = 50;


/** To what extent round position */
Draggable.prototype.precision = 1;


/** Droppable params */
Draggable.prototype.droppable = null;
Draggable.prototype.droppableTolerance = 0.5;
Draggable.prototype.droppableClass = null;


/** Slow down movement by pressing ctrl/cmd */
Draggable.prototype.sniper = true;


/** How much to slow sniper drag */
Draggable.prototype.sniperSlowdown = .85;


/**
 * Restrict movement by axis
 *
 * @default undefined
 * @enum {string}
 */
Draggable.prototype.move = function (x, y) {
	if (this.axis === 'x') {
		if (x == null) x = this.prevX;
		if (y == null) y = this.prevY;

		var limits = this.limits;

		if (this.repeat) {
			var w = (limits.right - limits.left);
			var oX = - this.initOffsetX + this.withinOffsets.left - this.pin[0] - Math.max(0, this.overflowX);
			x = loop(x - oX, w) + oX;
		} else {
			x = between(x, limits.left, limits.right);
		}

		this.setCoords(x);
	}
	else if (this.axis === 'y') {
		if (x == null) x = this.prevX;
		if (y == null) y = this.prevY;

		var limits = this.limits;

		if (this.repeat) {
			var h = (limits.bottom - limits.top);
			var oY = - this.initOffsetY + this.withinOffsets.top - this.pin[1] - Math.max(0, this.overflowY);
			y = loop(y - oY, h) + oY;
		} else {
			y = between(y, limits.top, limits.bottom);
		}

		this.setCoords(null, y);
	}
	else {
		if (x == null) x = this.prevX;
		if (y == null) y = this.prevY;

		var limits = this.limits;

		if (this.repeat) {
			var w = (limits.right - limits.left);
			var h = (limits.bottom - limits.top);
			var oX = - this.initOffsetX + this.withinOffsets.left - this.pin[0] - Math.max(0, this.overflowX);
			var oY = - this.initOffsetY + this.withinOffsets.top - this.pin[1] - Math.max(0, this.overflowY);
			if (this.repeat === 'x') {
				x = loop(x - oX, w) + oX;
			}
			else if (this.repeat === 'y') {
				y = loop(y - oY, h) + oY;
			}
			else {
				x = loop(x - oX, w) + oX;
				y = loop(y - oY, h) + oY;
			}
		}

		x = between(x, limits.left, limits.right);
		y = between(y, limits.top, limits.bottom);

		this.setCoords(x, y);
	}
};


/** Repeat movement by one of axises */
Draggable.prototype.repeat = false;


/** Check whether arr is filled with zeros */
function isZeroArray(arr) {
	if (!arr[0] && !arr[1] && !arr[2] && !arr[3]) return true;
}



/** Clean all memory-related things */
Draggable.prototype.destroy = function () {
	var self = this;

	self.currentHandles.forEach(function (handle) {
		off(handle, self._ns);
	});

	self.state = 'destroy';

	clearTimeout(self._animateTimeout);

	off(doc, self._ns);
	off(self.element, self._ns);


	self.element = null;
	self.within = null;
};



//little helpers

function q (str) {
	if (Array.isArray(str)) {
		return str.map(q).reduce( (prev, curr) => prev.concat(curr), [] );
	}
	else if (str instanceof HTMLElement) {
		return [str];
	}
	else {
		return [].slice.call(document.querySelectorAll(str));
	}
}


module.exports = Draggable;