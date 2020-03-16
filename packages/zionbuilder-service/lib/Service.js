const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const Options = require('./Options')
const Config = require('webpack-chain')
const hash = require('hash-sum')
const merge = require('webpack-merge')
const resolvePkg = require('./util/resolvePkg').resolvePkg
const findFreePort = require('find-free-port-sync')

module.exports = class Service {
	constructor (context, { pkg } = {}) {
		this.context = context
		this.options = new Options( this.resolveConfig(), {
			outputDir: this.resolve(this.context, './dist/'),
			assetsDir: this.resolve(this.context, './dist/'),
		})
		this.webpackChainFns = []

		this.availablePort = findFreePort()
		this.entries = {}

		// Folder containing the target package.json for plugins
		this.pkgContext = context
		// package.json containing the plugins
		this.pkg = this.resolvePkg(pkg)

		// Add user chain webpack
		const userChainWebpack = this.options.getOption('chainWebpack')
		if ( userChainWebpack && typeof userChainWebpack === 'function' ) {
			this.webpackChainFns.push(userChainWebpack)
		}

		process.ZIONBUILDER_SERVICE = this

		this.commands = {
			serve: require('./commands/serve'),
			build: require('./commands/build')
		}
	}

	resolvePkg (inlinePkg, context = this.context) {
		if (inlinePkg) {
		  return inlinePkg
		}
		const pkg = resolvePkg(context)
		if (pkg.vuePlugins && pkg.vuePlugins.resolveFrom) {
		  this.pkgContext = path.resolve(context, pkg.vuePlugins.resolveFrom)
		  return this.resolvePkg(null, this.pkgContext)
		}
		return pkg
	}

	resolveConfig () {
		let fileConfig

		const configPath = (
			path.resolve(this.context, 'zionbuilder.config.js')
		)

		if (fs.existsSync(configPath)) {
			try {
				fileConfig = require(configPath)

				if (typeof fileConfig === 'function') {
					fileConfig = fileConfig()
				}

				if (!fileConfig || typeof fileConfig !== 'object') {
					console.error(
					`Error loading ${chalk.bold('zionbuilder.config.js')}: should export an object or a function that returns object.`
					)
					fileConfig = null
				}
			} catch (e) {
				console.error(`Error loading ${chalk.bold('zionbuilder.config.js')}:`)
				throw e
			}
		}

		return fileConfig
	}

	setEnvironmentMode( environmentMode = 'production' ) {
		process.env.NODE_ENV = environmentMode
	}

	run(name, args, rawArgv) {
		const command = this.commands[name]

		// Set the proper mode
		const environmentMode = name === 'build' ? 'production' : 'development'
		this.setEnvironmentMode(environmentMode)
		
		args._.shift() // remove command itself
		rawArgv.shift()

		return command(this.options, args)
	}

	init( environmentMode = 'production' ) {
		this.setEnvironmentMode(environmentMode)
	}

	resolveWebpackChain () {
		const chainableWebpackConfig = new Config()

		// Add default rules
		const webpackConfigs = [
			'./configs/base',
			'./configs/css',
			'./configs/js'
		]

		const baseConfigs = []

		webpackConfigs.forEach(configFile => {
			baseConfigs.push(require( configFile ))
		});
		baseConfigs.forEach(fn => fn(chainableWebpackConfig, this))

		this.webpackChainFns.forEach(fn => fn(chainableWebpackConfig, this))
		return chainableWebpackConfig
	}

	chainWebpack (fn) {
		this.webpackChainFns.push(fn)
	}

	getPublicPath () {
		const publicPath = this.options.getOption('publicPath')

		if (publicPath) {
			return publicPath
		}

		return `http://localhost:${this.availablePort}/`
	}

	setEntries (entries) {
		const glob = require('glob')
		const elementsFolder = this.options.getOption('elementsFolder')

		/**
		 * Get all elements entries
		 */
		glob.sync(`${elementsFolder}/**/src/*(editor.js|element.scss)`).forEach((file) => {
			const fileInfo = path.parse(file)
			const destination = path.join(fileInfo.dir, '..')

			if (typeof entries[destination] === 'undefined') {
				entries[destination] = {}
			}

			entries[destination][fileInfo.name] = file
		})
	}


	getEntries () {
		return this.entries
	}

	getEntry (entryId) {
		return this.entries[entryId]
	}

	addEntryToWebpack () {

	}

	resolveWebpackConfig (chainableWebpackConfig = this.resolveWebpackChain()) {
		let config = chainableWebpackConfig.toConfig()
		const userWebpackConfig = this.options.getOption('configureWebpack', {})
		const userEntries = this.options.getOption('webpackEntries', {})
		const entries = {}

		// Sort entries based on outptup path
		Object.keys(userEntries).forEach(singleEntry => {
			const entryConfig = userEntries[singleEntry]
			const destination = entryConfig.destination || this.options.getOption('outputDir', './dist')

			if (typeof entries[destination] === 'undefined') {
				entries[destination] = {}
			}

			entries[destination][singleEntry] = entryConfig.source
		})

		// Add Elements Entries
		this.setEntries(entries)

		const multiCompilerConfig = []

		let appCount = 1
		Object.keys(entries).forEach(outputPath => {
			const entryFiles = entries[outputPath]
			multiCompilerConfig.push(merge(
				config,
				userWebpackConfig,
				{
					name: `zionApp${appCount}`,
					entry: entryFiles,
					output: {
						path: path.resolve( outputPath ),
						publicPath: `http://localhost:${this.availablePort}/${outputPath.replace('./', '')}`
					}
				}
			))

			appCount++
		})

		return multiCompilerConfig
	}

	resolve (requestedPath) {
		return path.resolve(this.context, requestedPath)
	}

	/**
	 * Generate a cache identifier from a number of variables
	 */
	genCacheConfig (id, partialIdentifier, configFiles = []) {
		const fs = require('fs')
		const cacheDirectory = this.resolve(`node_modules/.cache/${id}`)

		// replace \r\n to \n generate consistent hash
		const fmtFunc = conf => {
			if (typeof conf === 'function') {
			return conf.toString().replace(/\r\n?/g, '\n')
			}
			return conf
		}

		const variables = {
			partialIdentifier,
			'cli-service': require('../package.json').version,
			'cache-loader': require('cache-loader/package.json').version,
			env: process.env.NODE_ENV,
			config: [
				fmtFunc(this.options.getOption('chainWebpack')),
				fmtFunc( this.options.getOption('configureWebpack') )
			]
		}

		if (!Array.isArray(configFiles)) {
			configFiles = [configFiles]
		}
		configFiles = configFiles.concat([
			'package-lock.json',
			'yarn.lock',
			'pnpm-lock.yaml'
		])

		const readConfig = file => {
			const absolutePath = this.resolve(file)
			if (!fs.existsSync(absolutePath)) {
			return
			}

			if (absolutePath.endsWith('.js')) {
			// should evaluate config scripts to reflect environment variable changes
			try {
				return JSON.stringify(require(absolutePath))
			} catch (e) {
				return fs.readFileSync(absolutePath, 'utf-8')
			}
			} else {
			return fs.readFileSync(absolutePath, 'utf-8')
			}
		}

		variables.configFiles = configFiles.map(file => {
			const content = readConfig(file)
			return content && content.replace(/\r\n?/g, '\n')
		})

		const cacheIdentifier = hash(variables)
		return { cacheDirectory, cacheIdentifier }
	}
}