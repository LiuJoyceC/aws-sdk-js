var fs = require('fs');
var path = require('path');
var clientTemplate, clientLoaderTemplate;

function escapeRegExp(string) {
  return string.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}

// Generate service clients
function ClientCreator() {
  this._metadata = require('../apis/metadata');
  this._apisFolderPath = path.join(__dirname, '..', 'apis');
  this._clientFolderPath = path.join(__dirname, '..', 'clients');
  this._serviceCustomizationsFolderPath = path.join(__dirname, '..', 'lib', 'services');
  this._packageJsonPath = path.join(__dirname, '..', 'package.json');
  this._apiFileNames = null;
  this._clientTemplatePath = path.join(__dirname, 'client-template.js');
  this._clientLoaderTemplatePath = path.join(__dirname, 'client-loader-template.js');
}

ClientCreator.prototype.getAllApiFilenames = function getAllApiFilenames() {
    if (this._apiFileNames) {
        return this._apiFileNames;
    }
    var apiFileNames = fs.readdirSync(this._apisFolderPath);
    // filter out metadata
    this._apiFileNames = apiFileNames.filter(function(name) {
        return name !== 'metadata.json';
    });
    return this._apiFileNames;
};

ClientCreator.prototype.getAllApiFilenamesForService = function getAllApiFilenamesForService(modelName) {
    var serviceRegex = new RegExp('(^' + modelName + '-([\\d]{4}-[\\d]{2}-[\\d]{2})\\.([\\w]+))\\.json$');
    var modelRegex = /(([\d]{4}-[\d]{2}-[\d]{2})\.([\w]+))\.json$/;

    var models = {};
    var versions = {};
    this.getAllApiFilenames().filter(function(name) {
        return name.search(serviceRegex) === 0;
    }).forEach(function(name) {
        var matches = name.match(serviceRegex);
        if (!matches) {
            return;
        }
        var model = matches[1];
        var version = matches[2];
        var modelType = matches[3];
        if (!versions.hasOwnProperty(version)) {
            versions[version] = {};
        }
        var versionInfo = versions[version];
        switch (modelType) {
            case 'min':
                versionInfo.api = model;
                break;
            case 'paginators':
                versionInfo.paginators = model;
                break;
            case 'waiters2':
                versionInfo.waiters = model;
                break;
            default:
                return;
        }
    });
    models.versions = versions;
    return models;
};

ClientCreator.prototype.customizationsExist = function customizationsExist(serviceName) {
    var customizationsFolder = this._serviceCustomizationsFolderPath;
    return fs.existsSync(path.join(customizationsFolder, serviceName + '.js'));
};

ClientCreator.prototype.getClientTemplate = function getClientTemplate() {
  if (!clientTemplate) clientTemplate = fs.readFileSync(this._clientTemplatePath).toString();
  return clientTemplate;
};

ClientCreator.prototype.getClientLoaderTemplate = function getClientLoaderTemplate() {
  if (!clientLoaderTemplate) clientLoaderTemplate = fs.readFileSync(this._clientLoaderTemplatePath).toString();
  return clientLoaderTemplate;
};

ClientCreator.prototype.fillTemplate = function fillTemplate(code, replacers) {
  if (Array.isArray(replacers)) {
    replacers.forEach(function(subreplacers) {
      code = fillTemplate(code, subreplacers);
    });
  } else if (replacers && typeof replacers === 'object') {
    var replacerTags = Object.keys(replacers);
    var endTag = escapeRegExp('/**/\n');
    replacerTags.forEach(function(replacerTag) {
      var replacer = replacers[replacerTag];
      var escapedTag = escapeRegExp(replacerTag);
      if (typeof replacer === 'string') {
        code = code.replace(new RegExp(escapedTag, 'g'), replacer);
      } else if (typeof replacer === 'function') {
        var block;
        var tagRegExp = new RegExp(escapedTag + '\n([^]*?)' + escapedTag + endTag);
        while (block = code.match(tagRegExp)) {
          code = code.replace(block[0], replacer(block[1]));
        }
      }
    });
  }
  return code;
};

ClientCreator.prototype.generateClientFileSource = function generateClientFileSource(serviceMetadata, specifiedVersion) {
  var clientFolderPath = this._clientFolderPath;
  var className = serviceMetadata.name;
  var serviceName = className.toLowerCase();
  var modelName = serviceMetadata.prefix || serviceName;
  specifiedVersion = specifiedVersion || '*';

  // get models for the service
  var models = this.getAllApiFilenamesForService(modelName);

  var modelVersions = models && models.versions;
  if (!modelVersions) {
      throw new Error('Unable to get models for ' + modelName);
  }
  var versionNumbers = Object.keys(modelVersions);
  var self = this;

  var replacers = {
    '$className': className,
    '$serviceName': serviceName,
    '$versionNumbers': versionNumbers.join('\', \''),

    '/*ifcustomizations*/': function(codeblock) {
      return self.customizationsExist(serviceName) ? codeblock : '';
    },

    '/*eachVersion*/': function(codeblock) {
      var loaderPrefix;
      codeblock = self.fillTemplate(codeblock, {
        '/*$loaderPrefix*/': function(prefix) {loaderPrefix = prefix.trim(); return '';}
      });
      codeblock = self.fillTemplate(codeblock, {'$loaderPrefix': loaderPrefix});
      return versionNumbers.map(function(version) {
        // check version
        if (specifiedVersion !== '*' && specifiedVersion !== version) return;
        var versionInfo = modelVersions[version];
        if (!versionInfo.hasOwnProperty('api')) {
          throw new Error('No API model for ' + serviceName + '-' + version);
        }
        var hasPaginators = versionInfo.hasOwnProperty('paginators');
        var hasWaiters = versionInfo.hasOwnProperty('waiters');
        var subreplacers = {
          '$version': version,
          '$api': versionInfo.api,
          '/*ifpaginators*/': function(codeblock) { return hasPaginators ? codeblock : ''; },
          '/*ifwaiters*/': function(codeblock) { return hasWaiters ? codeblock : ''; }
        };
        if (hasPaginators) subreplacers['$paginators'] = versionInfo.paginators;
        if (hasWaiters) subreplacers['$waiters'] = versionInfo.waiters;
        return self.fillTemplate(codeblock, subreplacers);
      }).join('\n');
    },

    '/*comment*/': function() { return ''; }
  };

  return {
      code: this.fillTemplate(this.getClientTemplate(), replacers),
      path: path.join(clientFolderPath, serviceName + '.js'),
      service: serviceName,
  };
};

ClientCreator.prototype.generateAllServicesSource = function generateAllServicesSource(services, fileName) {
  var metadata = this._metadata;
  var self = this;
  var replacers = {
    '/*eachService*/': function(codeblock) {
      return services.map(function(service) {
        return self.fillTemplate(codeblock, {
          '$serviceName': service,
          '$className': metadata[service].name
        });
      }).join('');
    }
  };
  return {
    code: this.fillTemplate(this.getClientLoaderTemplate(), replacers),
    path: path.join(this._clientFolderPath, fileName + '.js'),
    service: fileName
  };
};

ClientCreator.prototype.getDefaultServices = function getDefaultServices() {
  var metadata = this._metadata;
  var services = [];
  for (var key in metadata) {
    if (!metadata.hasOwnProperty(key)) {
      continue;
    }
    var className = metadata[key].name;
    var serviceName = className.toLowerCase();
    services.push(serviceName);
  }
  return services;
};

ClientCreator.prototype.writeClientServices = function writeClientServices() {
  var metadata = this._metadata;
  var services = [];
  var corsServices = [];
  for (var key in metadata) {
    if (!metadata.hasOwnProperty(key)) {
      continue;
    }
    var clientInfo = this.generateClientFileSource(metadata[key]);
    fs.writeFileSync(clientInfo.path, clientInfo.code);
    services.push(clientInfo.service);
    // check if service supports CORS
    if (metadata[key].cors === true) {
      corsServices.push(clientInfo.service);
    }
  }
  var allClientInfo = this.generateAllServicesSource(services, 'all');
  fs.writeFileSync(allClientInfo.path, allClientInfo.code);
  var browserClientInfo = this.generateAllServicesSource(corsServices, 'browser_default');
  fs.writeFileSync(browserClientInfo.path, browserClientInfo.code);
};

module.exports = ClientCreator;