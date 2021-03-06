var _ = require('lodash');
var Exporter = require('./exporter');
var ramlHelper = require('../helpers/raml');
var jsonHelper = require('../utils/json');
var YAML = require('js-yaml');

function RAMLDefinition(title, env) {
	this.title = title;
	//TODO anyway to know version?
	this.version = env.Version;
	var baseUri = env.Host + env.BasePath;
	if (baseUri) {
		this.baseUri = baseUri;
	}
	this.mediaType = env.DefaultResponseType || '';

	var protocols = mapProtocols(env.Protocols);
	if (!_.isEmpty(protocols)) {
		this.protocols = protocols;
	}
}

RAMLDefinition.prototype.addMethod = function(resource, methodURIs, methodKey, method) {
	if (!methodURIs) return;

	if (methodURIs.length <= 0) {
		//reach the leaf of tree
		//TODO optional: check same method existence
		if (!resource.uriParameters) {
			resource.uriParameters = {};
		}
		for (var attrname in method.uriParameters) {
			if (!method.uriParameters.hasOwnProperty(attrname)) continue;
			//uri not available, so check with displayName, which is same
			var isURIParamExist = resource.displayName.split(attrname).length - 1;
			if (isURIParamExist) {
				resource.uriParameters[attrname] = method.uriParameters[attrname];
			}
		}

		delete method.uriParameters;
		if (_.isEmpty(resource.uriParameters)) delete resource.uriParameters;

		resource[methodKey] = method;
	} else {
		var currentURI = '/' + methodURIs[0];
		if (!resource[currentURI]) {
			resource[currentURI] = {
				displayName: methodURIs[0].replace(/<|>|{|}/g, ''),
			};
			//TODO uriParams?!?
		}
		methodURIs.splice(0, 1);
		this.addMethod(resource[currentURI], methodURIs, methodKey, method);
	}
};

function RAML() {
	this.hasTags = false;
	this.hasDeprecated = false;
	this.hasExternalDocs = false;
	this.hasInfo = false;
}

RAML.prototype = new Exporter();

RAML.prototype._mapSecurityScheme = function(slSecuritySchemes) {
	var ramlSecuritySchemes = {};

	if (slSecuritySchemes.hasOwnProperty('oauth2')) {
		var name = slSecuritySchemes.oauth2.name || 'oauth2';
		// missing describedBy, description

		ramlSecuritySchemes[name] = {
			type: 'OAuth 2.0',
			settings: {
				authorizationUri: slSecuritySchemes.oauth2.authorizationUrl || undefined,
				accessTokenUri: slSecuritySchemes.oauth2.tokenUrl || '',
				authorizationGrants: this.mapAuthorizationGrants(slSecuritySchemes.oauth2.flow),
			},
		};

		var scopes = [];
		if (slSecuritySchemes.oauth2.scopes && !_.isEmpty(slSecuritySchemes.oauth2.scopes)) {
			for (var index in slSecuritySchemes.oauth2.scopes) {
				if (!slSecuritySchemes.oauth2.scopes.hasOwnProperty(index)) continue;
				var scope = slSecuritySchemes.oauth2.scopes[index].name;
				scopes.push(scope);
			}

			ramlSecuritySchemes[name]['settings']['scopes'] = scopes;
		}
	}

	if (slSecuritySchemes.hasOwnProperty('basic')) {
		var basicName = slSecuritySchemes.basic.name;
		if (basicName) {
			ramlSecuritySchemes[basicName] = {
				type: 'Basic Authentication',
				description: slSecuritySchemes.basic.description,
			};
		}
	}

	if (slSecuritySchemes.hasOwnProperty('apiKey')) {
		var name = null;
		var content = {};
		var description = null;

		// add header auth
		if (!_.isEmpty(slSecuritySchemes.apiKey.headers)) {
			name = slSecuritySchemes.apiKey.headers[0].externalName;
			description = slSecuritySchemes.apiKey.headers[0].description;

			content.headers = {};
			for (var i in slSecuritySchemes.apiKey.headers) {
				if (!slSecuritySchemes.apiKey.headers.hasOwnProperty(i)) continue;

				var q = slSecuritySchemes.apiKey.headers[i];
				var keyName = q.name;
				content.headers[keyName] = {
					type: 'string',
				};
			}
		}

		// add query auth
		if (!_.isEmpty(slSecuritySchemes.apiKey.queryString)) {
			name = slSecuritySchemes.apiKey.queryString[0].externalName;
			description = slSecuritySchemes.apiKey.queryString[0].description;

			content.queryParameters = {};
			for (var i in slSecuritySchemes.apiKey.queryString) {
				if (!slSecuritySchemes.apiKey.queryString.hasOwnProperty(i)) continue;

				var q = slSecuritySchemes.apiKey.queryString[i];
				var keyName = q.name;
				content.queryParameters[keyName] = {
					type: 'string',
				};
			}
		}

		if (!_.isEmpty(content)) {
			ramlSecuritySchemes[name || 'apiKey'] = {
				type: this.getApiKeyType(),
				describedBy: content,
				description: description,
			};
		}
	}

	return this.mapSecuritySchemes(ramlSecuritySchemes);
};

RAML.prototype._validateParam = function(params) {
	var acceptedTypes = ['string', 'number', 'integer', 'date', 'boolean', 'file', 'array'];
	for (var key in params) {
		if (!params.hasOwnProperty(key)) continue;
		var param = params[key];
		for (var prop in param) {
			if (!param.hasOwnProperty(prop)) continue;
			switch (prop) {
				case 'type':
					var type = param.type;
					if (acceptedTypes.indexOf(type) < 0) {
						//not supported type, delete param
						delete params[key];
						continue;
					}
					break;
				case 'enum':
				case 'pattern':
				case 'minLength':
				case 'maxLength':
					if (param.type !== 'string') {
						delete param[prop];
					}
					break;
				case 'minimum':
				case 'maximum':
					if (param) {
						var typeLowercase = _.toLower(param.type);
						if (typeLowercase !== 'integer' && typeLowercase !== 'number') {
							delete param[prop];
						}
					}
					break;
				case 'required':
				case 'displayName':
				case 'description':
				case 'example':
				case 'repeat':
				case 'default':
				case 'items':
					break;
				default:
					//not supported types
					if (param) {
						delete param[prop];
					}
			}
		}
	}

	return params;
};

RAML.prototype._mapRequestBody = function(bodyData, mimeType) {
	var body = {};
	if (!bodyData.body) return body;

	switch (mimeType) {
		case 'application/json':
			body[mimeType] = jsonHelper.stringify(this.mapBody(bodyData), 2);
			break;
		case 'multipart/form-data':
		case 'application/x-www-form-urlencoded':
			var parsedBody = jsonHelper.parse(bodyData.body);
			body[mimeType] = this.mapRequestBodyForm(parsedBody);
			break;
		default:
			body['application/json'] = jsonHelper.stringify(this.mapBody(bodyData), 2);
			break;
	}

	if (bodyData.description) {
		body[mimeType].description = bodyData.description;
	}

	return body;
};

RAML.prototype._mapNamedParams = function(params) {
	if (!params || _.isEmpty(params.properties)) return;

	var newParams = {};
	for (var key in params.properties) {
		if (!params.properties.hasOwnProperty(key)) continue;
		newParams[key] = ramlHelper.setParameterFields(params.properties[key], {});
		if (params.required && params.required.indexOf(key) > -1) {
			newParams[key].required = true;
		}
		newParams[key] = jsonHelper.orderByKeys(newParams[key], ['type', 'description']);
	}
	return this._validateParam(newParams);
};

RAML.prototype._mapResponseBody = function(responseData, mimeType) {
	var responses = {};

	for (var i in responseData) {
		if (!responseData.hasOwnProperty(i)) continue;

		var resBody = responseData[i];
		if (!_.isEmpty(resBody.codes)) {
			var code = resBody.codes[0];
			if (code === 'default' || parseInt(code) == 'NaN') {
				continue;
			}

			var type = mimeType || 'application/json';
			if (type || resBody) {
				_.set(responses, [code, 'body', type], jsonHelper.stringify(this.mapBody(resBody), 2));
			} else {
				responses[code] = {};
			}

			if (resBody.description) {
				responses[code]['description'] = resBody.description;
			}

			if (!jsonHelper.isEmptySchema(resBody.headers)) {
				responses[code]['body'][type].headers = this._mapNamedParams(resBody.headers);
			}
		}
	}

	return responses;
};

//TODO: Stoplight doesn't support seperate path params completely yet
RAML.prototype._mapURIParams = function(pathParamData) {
	if (!pathParamData.properties || _.isEmpty(pathParamData.properties)) {
		return;
	}

	var pathParams = {};
	for (var key in pathParamData.properties) {
		if (!pathParamData.properties.hasOwnProperty(key)) continue;
		var prop = pathParamData.properties[key];

		pathParams[key] = ramlHelper.setParameterFields(prop, {});
		if (prop.description) {
			pathParams[key].displayName = prop.description
				? prop.description.replace(/<|>|{|}/g, '')
				: null;
		}
		if (prop.items) {
			pathParams[key].items = prop.items;
		}

		pathParams[key].type = pathParams[key].type || 'string';
	}

	return this._validateParam(pathParams);
};

function mapProtocols(protocols) {
	var validProtocols = [];
	for (var i in protocols) {
		if (
			!protocols.hasOwnProperty(i) ||
			(_.toLower(protocols[i]) != 'http' && _.toLower(protocols[i]) != 'https')
		) {
			//RAML incompatible formats( 'ws' etc)
			continue;
		}
		validProtocols.push(_.toUpper(protocols[i]));
	}
	return validProtocols;
}

RAML.prototype._mapTextSections = function(slTexts) {
	var results = [];
	if (!slTexts) return resilts;

	for (var i in slTexts) {
		if (!slTexts.hasOwnProperty(i)) continue;
		var text = slTexts[i];

		if (text.divider || _.isEmpty(text.name) || _.isEmpty(text.content)) {
			continue;
		}

		results.push({
			title: text.name,
			content: text.content,
		});
	}

	return results;
};

// from ref=type1 to type=type1
// from $ref=#/definitions/type1 to type=type1
// from $ref=definitions/type1 to !include definitions/type1
RAML.prototype.convertRefFromModel = function(object) {
	for (var id in object) {
		if (object.hasOwnProperty(id)) {
			var val = object[id];
			if (id == '$ref') {
				if (val.indexOf('#/') == 0) {
					object.type = val.replace('#/definitions/', '');
				} else {
					object.type = '!include ' + val;
				}
				delete object[id];
			} else if (typeof val === 'string') {
				if (id == 'ref') {
					object.type = val;
					delete object[id];
				} else if (id == 'include') {
					object.type = '!include ' + val;
					delete object[id];
				}
			} else if (val && typeof val === 'object') {
				if (val.type == 'string') {
					if (val.format == 'byte' || val.format == 'binary' || val.format == 'password') {
						object[id] = {
							type: 'string',
						};
					} else if (val.format == 'date') {
						object[id] = {
							type: 'date-only',
						};
					} else if (val.format == 'date-time') {
						object[id] = {
							type: 'datetime',
							format: 'rfc3339',
						};
					} else {
						//remove invalid format.
						if (ramlHelper.getValidFormat.indexOf(val.format) < 0) {
							delete object[id].format;
						}
					}
				} else {
					object[id] = this.convertRefFromModel(val);
				}
			} else if (id === '$ref') {
				object.type = val.replace('#/definitions/', '');
				delete object[id];
			} else if (id === 'exclusiveMinimum' || id === 'exclusiveMaximum') {
				delete object[id];
			}
		}
	}

	return object;
};

RAML.prototype._mapTraits = function(slTraits, mimeType) {
	var traits = this.initializeTraits();
	// var traits = [];
	// var traitMap = {};

	for (var i in slTraits) {
		if (!slTraits.hasOwnProperty(i)) continue;
		var slTrait = slTraits[i], trait = {};

		try {
			var queryString = jsonHelper.parse(slTrait.request.queryString);
			if (!jsonHelper.isEmptySchema(queryString)) {
				trait.queryParameters = this._mapNamedParams(queryString);
			}
		} catch (e) {}

		try {
			var headers = jsonHelper.parse(slTrait.request.headers);
			if (!jsonHelper.isEmptySchema(headers)) {
				trait.headers = this._mapNamedParams(headers);
			}
		} catch (e) {}

		try {
			if (slTrait.responses && slTrait.responses.length) {
				trait.responses = this._mapResponseBody(slTrait.responses, mimeType);
			}
		} catch (e) {}

		this.addTrait(slTrait.name, trait, traits);

		//   var traitKey = _.camelCase(slTrait.name);
		//   var newTrait = {};
		//   newTrait[traitKey] = trait;
		//   traits.push(newTrait);
		//   traitMap[traitKey] = trait;
	}
	//
	// if (this.version() === '1.0') {
	//   return traitMap;
	// }

	return traits;
};

RAML.prototype._mapEndpointTraits = function(slTraits, endpoint) {
	var is = [];

	for (var i in endpoint.traits) {
		if (!endpoint.traits.hasOwnProperty(i)) continue;
		var trait = _.find(slTraits, ['_id', endpoint.traits[i]]);
		if (!trait) {
			continue;
		}
		is.push(_.camelCase(trait.name));
	}

	return is;
};

function getDefaultMimeType(mimeType, defMimeType) {
	var mt = mimeType && mimeType.length > 0 ? mimeType[0] : null;
	if (!mt) {
		if (_.isArray(defMimeType) && defMimeType.length) {
			mt = defMimeType[0];
		} else if (_.isString(defMimeType) && defMimeType !== '') {
			mt = defMimeType;
		}
	}
	return mt;
}

RAML.prototype._export = function() {
	var env = this.project.Environment;
	var ramlDef = new RAMLDefinition(this.project.Name, env);

	ramlDef.mediaType = this.mapMediaType(env.Consumes, env.Produces);
	this.description(ramlDef, this.project);

	if (this.project.Environment.ExternalDocs) {
		this.hasExternalDocs = true;
		ramlDef['(externalDocs)'] = {
			description: this.project.Environment.ExternalDocs.description,
			url: this.project.Environment.ExternalDocs.url,
		};
	}

	if (
		this.project.Environment.contactInfo ||
		this.project.Environment.termsOfService ||
		this.project.Environment.license
	) {
		ramlDef['(info)'] = {};
		this.hasInfo = true;
	}

	if (this.project.Environment.contactInfo) {
		ramlDef['(info)'].contact = {};
		if (this.project.Environment.contactInfo.name) {
			ramlDef['(info)'].contact.name = this.project.Environment.contactInfo.name;
		}
		if (this.project.Environment.contactInfo.url) {
			ramlDef['(info)'].contact.url = this.project.Environment.contactInfo.url;
		}
		if (this.project.Environment.contactInfo.email) {
			ramlDef['(info)'].contact.email = this.project.Environment.contactInfo.email;
		}
	}

	if (this.project.Environment.termsOfService) {
		ramlDef['(info)'].termsOfService = this.project.Environment.termsOfService;
	}

	if (this.project.Environment.license) {
		ramlDef['(info)'].license = {};
		if (this.project.Environment.license.name) {
			ramlDef['(info)'].license.name = this.project.Environment.license.name;
		}
		if (this.project.Environment.license.url) {
			ramlDef['(info)'].license.url = this.project.Environment.license.url;
		}
	}

	var docs = this._mapTextSections(this.project.Texts);
	if (docs.length) {
		ramlDef.documentation = ramlDef.documentation || [];
		ramlDef.documentation = ramlDef.documentation.concat(docs);
	}

	var slSecuritySchemes = this.project.Environment.SecuritySchemes;
	var securitySchemes = this._mapSecurityScheme(slSecuritySchemes);

	if (!_.isEmpty(securitySchemes)) {
		ramlDef.securitySchemes = securitySchemes;
	}

	var endpoints = this.project.Endpoints;

	// Collect endpoints ids from environment resourcesOrder
	var orderedIds = env.resourcesOrder.docs.reduce(function(ids, group) {
		return ids.concat(_.map(_.filter(group.items, { type: 'endpoints' }), '_id'));
	}, []);

	// Sort endpoints similar to resourcesOrder items order
	endpoints.sort(function(a, b) {
		return orderedIds.indexOf(a._id) < orderedIds.indexOf(b._id) ? -1 : 1;
	});

	for (var i in endpoints) {
		if (!endpoints.hasOwnProperty(i)) continue;
		var endpoint = endpoints[i];

		var method = {};
		this.setMethodDisplayName(method, endpoint.operationId || endpoint.Name);
		if (endpoint.Description) {
			method.description = endpoint.Description;
		}
		if (endpoint.Summary) {
			method.description = endpoint.Summary + (method.description ? '. ' + method.description : '');
		}

		var is = this._mapEndpointTraits(this.project.Traits, endpoint);
		if (is.length) {
			method.is = is;
		}

		if (
			_.toLower(endpoint.Method) === 'post' ||
			_.toLower(endpoint.Method) === 'put' ||
			_.toLower(endpoint.Method) === 'patch'
		) {
			var mimeType = getDefaultMimeType(endpoint.Consumes, ramlDef.mediaType);
			method.body = this._mapRequestBody(endpoint.Body, mimeType);
		}

		method.headers = this._mapNamedParams(endpoint.Headers);

		var mimeType = getDefaultMimeType(endpoint.Produces, ramlDef.mediaType);
		method.responses = this._mapResponseBody(endpoint.Responses, mimeType);

		method.queryParameters = this._mapURIParams(endpoint.QueryString);

		method.uriParameters = this._mapURIParams(endpoint.PathParams);

		if (endpoint.securedBy) {
			var rsecuredBy = [];
			if (endpoint.securedBy.oauth2) {
				var securedName = slSecuritySchemes.oauth2.name || 'oauth2';
				if (!_.isEmpty(endpoint.securedBy.oauth2)) {
					var scopes = {};
					scopes[securedName] = {
						scopes: endpoint.securedBy.oauth2,
					};
					rsecuredBy.push(scopes);
				} else {
					rsecuredBy.push(securedName);
				}
			}
			if (endpoint.securedBy.basic && slSecuritySchemes.basic.name) {
				rsecuredBy.push(slSecuritySchemes.basic.name);
			}
			if (endpoint.securedBy.apiKey) {
				if (slSecuritySchemes.apiKey) {
					if (!_.isEmpty(slSecuritySchemes.apiKey.headers)) {
						rsecuredBy.push(slSecuritySchemes.apiKey.headers[0].externalName);
					} else if (!_.isEmpty(slSecuritySchemes.apiKey.queryString)) {
						rsecuredBy.push(slSecuritySchemes.apiKey.queryString[0].externalName);
					}
				}
			}
			if (rsecuredBy.length > 0) {
				method.securedBy = rsecuredBy;
			}
		}

		var uriParts = endpoint.Path.split('/');
		uriParts.splice(0, 1);
		ramlDef.addMethod(ramlDef, uriParts, endpoint.Method, method);

		if (endpoint.Tags && !_.isEmpty(endpoint.Tags)) {
			this.hasTags = true;
			method['(tags)'] = endpoint.Tags;
		}

		if (endpoint.Deprecated) {
			this.hasDeprecated = true;
			method['(deprecated)'] = endpoint.Deprecated;
		}

		if (endpoint.ExternalDocs) {
			this.hasExternalDocs = true;
			method['(externalDocs)'] = {
				description: endpoint.ExternalDocs.description,
				url: endpoint.ExternalDocs.url,
			};
		}
	}

	if (this.hasTags || this.hasDeprecated || this.hasExternalDocs || this.hasInfo) {
		ramlDef.annotationTypes = {};
		if (this.hasTags) {
			ramlDef.annotationTypes.tags = 'string[]';
		}

		if (this.hasDeprecated) {
			ramlDef.annotationTypes.deprecated = 'boolean';
		}

		if (this.hasExternalDocs) {
			ramlDef.annotationTypes.externalDocs = {
				properties: {
					'description?': 'string',
					url: 'string',
				},
			};
		}

		if (this.hasInfo) {
			ramlDef.annotationTypes.info = {
				properties: {
					'termsOfService?': 'string',
					'contact?': {
						properties: {
							'name?': 'string',
							'url?': 'string',
							'email?': 'string',
						},
					},
					'license?': {
						properties: {
							'name?': 'string',
							'url?': 'string',
						},
					},
				},
			};
		}
	}

	if (this.project.Schemas && this.project.Schemas.length > 0) {
		this.addSchema(ramlDef, this.mapSchema(this.project.Schemas));
	}

	if (this.project.Traits && this.project.Traits.length > 0) {
		ramlDef.traits = this._mapTraits(this.project.Traits);
	}

	// Clean empty field in definition
	for (var field in ramlDef) {
		if (ramlDef.hasOwnProperty(field) && !ramlDef[field]) {
			delete ramlDef[field];
		}
	}

	this.data = ramlDef;
};

RAML.prototype._unescapeYamlIncludes = function(yaml) {
	var start = yaml.indexOf("'!include ");
	if (start == -1) return yaml;
	var end = yaml.indexOf("'", start + 1);
	if (end == -1) return yaml;
	return (
		yaml.substring(0, start) +
		yaml.substring(start + 1, end) +
		this._unescapeYamlIncludes(yaml.substring(end + 1))
	);
};

RAML.prototype._getData = function(format) {
	switch (format) {
		case 'yaml':
			var yaml = this._unescapeYamlIncludes(
				YAML.dump(jsonHelper.parse(JSON.stringify(this.Data)), { lineWidth: -1 })
			);
			return '#%RAML ' + this.version() + '\n' + yaml;
		default:
			throw Error('RAML doesn not support ' + format + ' format');
	}
};

RAML.prototype.description = function(ramlDef, project) {
	throw new Error('description method not implemented');
};

RAML.prototype.version = function() {
	throw new Error('version method not implemented');
};

RAML.prototype.mapAuthorizationGrants = function(flow) {
	throw new Error('mapAuthorizationGrants method not implemented');
};

RAML.prototype.mapBody = function(bodyData) {
	throw new Error('mapBody method not implemented');
};

RAML.prototype.mapRequestBodyForm = function(bodyData) {
	throw new Error('mapRequestBodyForm method not implemented');
};

RAML.prototype.addSchema = function(ramlDef, schema) {
	throw new Error('addSchema method not implemented');
};

RAML.prototype.mapSchema = function(schema) {
	throw new Error('mapSchema method not implemented');
};

RAML.prototype.getApiKeyType = function() {
	throw new Error('getApiType method not implemented');
};

RAML.prototype.mapSecuritySchemes = function(securitySchemes) {
	throw new Error('mapSecuritySchemes method not implemented');
};

RAML.prototype.setMethodDisplayName = function(method, displayName) {
	throw new Error('setMethodDisplayName method not implemented');
};

RAML.prototype.initializeTraits = function() {
	throw new Error('initializeTraits method not implemented');
};

RAML.prototype.addTrait = function(id, trait, traits) {
	throw new Error('addTrait method not implemented');
};

module.exports = RAML;
