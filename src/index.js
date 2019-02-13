'use strict'

const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const neon = require('neon-js')
const pkgUp = require('pkg-up')
const RawModule = require('webpack/lib/RawModule')
const findCacheDir = require('find-cache-dir')

class GoogleFontsWebpackPlugin {
  static pluginName = 'google-fonts-plugin'
  static defaultOptions = {
    fonts: [
      {
        family: 'Roboto',
        variants: [
          '400',
          '400i',
          '700',
          '700i'
        ],
        subsets: [
          'latin',
          'latin-ext'
        ]
      }
    ],
    formats: [
      'eot',
      'ttf',
      'woff',
      'woff2'
    ],
    formatAgents: {
      'eot': 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; WOW64; Trident/4.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET4.0C; .NET4.0E)',
      'ttf': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/534.59.8 (KHTML, like Gecko) Version/5.1.9 Safari/534.59.8',
      'woff': 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; .NET4.0C; .NET4.0E; .NET CLR 2.0.50727; .NET CLR 3.0.30729; .NET CLR 3.5.30729; rv:11.0) like Gecko',
      'woff2': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; ServiceUI 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.79 Safari/537.36 Edge/14.14393'
    },
    chunkName: 'google-fonts',
    encode: true,
    cache: true
  }

  constructor (options) {
    this.options = {}
    if (typeof options === 'object') {
      Object.assign(this.options, GoogleFontsWebpackPlugin.defaultOptions, options)
    } else if (typeof options === 'string') {
      let file = fs.readFileSync(options, 'utf8')
      let fileOptions = {}
      if (/\.neon$/.test(options)) {
        fileOptions = neon.decode(file.replace(/\r\n/g, '\n'), 'object')
      } else {
        fileOptions = JSON.parse(file)
      }
      Object.assign(this.options, GoogleFontsWebpackPlugin.defaultOptions, this.getConfig(fileOptions))
    } else {
      let file = fs.readFileSync(pkgUp.sync(), 'utf8')
      let fileOptions = JSON.parse(file)
      Object.assign(this.options, GoogleFontsWebpackPlugin.defaultOptions, this.getConfig(fileOptions))
    }
  }

  getConfig (options) {
    for (let key of Object.keys(options)) {
      if (key === GoogleFontsWebpackPlugin.pluginName) {
        return options[key]
      } else if (options[key] instanceof Object && Object.keys(options[key]).length !== 0) {
        const result = this.getConfig(options[key])

        if (result) {
          return result
        }
      }
    }
  }

  getCacheKey (requestUrl, format) {
    const hashedUrl = crypto.createHash('sha1').update(requestUrl).digest('hex')
    return `${format}-${hashedUrl}`
  }

  getFromCache (key, encoding) {
    let contents = null
    const file = findCacheDir({
      name: GoogleFontsWebpackPlugin.pluginName,
      thunk: true
    })(key)

    if (fs.existsSync(file)) {
      contents = fs.readFileSync(file, encoding)
    }
    return contents
  }

  saveToCache (key, contents, encoding) {
    const file = findCacheDir({
      name: GoogleFontsWebpackPlugin.pluginName,
      create: true,
      thunk: true
    })(key)
    return fs.writeFileSync(file, contents, encoding)
  }

  createRequestStrings () {
    return Object.values(this.options.fonts).map(item => {
      if (item.family) {
        let requestString = 'https://fonts.googleapis.com/css?family=' + item.family.replace(/\s/gi, '+')

        if (item.variants) {
          requestString += ':' + Object.values(item.variants).join(',')
        }

        if (item.subsets) {
          requestString += '&subset=' + Object.values(item.subsets).join(',')
        }

        return requestString
      }
      return null
    })
  }

  async requestFont (requestString, format, encoding) {
    let response = null
    const cacheKey = this.getCacheKey(requestString, format)
    if (this.options.cache) {
      response = this.getFromCache(cacheKey, encoding)
    }

    if (!response) {
      response = (await axios({
        url: requestString,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': this.options.formatAgents[format]
        }
      })).data
      this.saveToCache(cacheKey, response, encoding)
    }

    return response
  }

  async requestFontsCSS (format) {
    const results = []
    for (const promise of this.createRequestStrings().map(requestString => this.requestFont(requestString, format, 'utf8'))) {
      results.push(await promise)
    }
    return results.join('')
  }

  async requestFontFiles (fontUrls) {
    const results = []
    for (const promise of fontUrls.map(fontUrl => this.requestFontFile(fontUrl))) {
      results.push(await promise)
    }
    return results
  }

  async requestFontFile (fontUrl) {
    if (fontUrl.startsWith('"data:application/')) {
      return fontUrl
    }

    const format = fontUrl.match(new RegExp('(' + Object.values(this.options.formats).join('|') + ')$'))[1]
    const font = await this.requestFont(fontUrl, format, 'binary')
    return `"data:application/x-font-${format};base64,${Buffer.from(font, 'binary').toString('base64')}"`
  }

  async encodeFonts (css) {
    if (this.options.encode) {
      const regex = /url\((.+?)\)/gi
      const fontUrls = css.match(regex).map(urlString => urlString.replace(regex, '$1'))
      const fontsEncoded = await this.requestFontFiles(fontUrls)
      fontsEncoded.forEach((font, index) => {
        css = css.replace(fontUrls[index], font)
      })
    }
    return css
  }

  apply (compiler) {
    const files = []

    compiler.hooks.make.tapAsync(GoogleFontsWebpackPlugin.pluginName, async (compilation, callback) => {
      for (const format of Object.values(this.options.formats)) {
        const css = await this.requestFontsCSS(format)
        const file = format + '.css'
        files.push(file)

        compilation.assets[file] = {
          source: () => css,
          size: () => Buffer.byteLength(css, 'utf8')
        }
      }

      const chunk = compilation.addChunk(this.options.chunkName)
      const webpackModule = new RawModule('', this.options.chunkName + '-module')
      webpackModule.buildInfo = {}
      webpackModule.buildMeta = {}
      webpackModule.hash = ''
      chunk.addModule(webpackModule)

      compilation.hooks.optimizeAssets.tapAsync(GoogleFontsWebpackPlugin.pluginName, async (assets, callback) => {
        const chunk = compilation.namedChunks.get(this.options.chunkName)
        delete compilation.assets[chunk.files[0]]
        chunk.files = files
        for (const file of files) {
          let css = await this.encodeFonts(assets[file].source())

          compilation.assets[file] = {
            source: () => css,
            size: () => Buffer.byteLength(css, 'utf8')
          }
        }

        callback()
      })

      callback()
    })
  }
}

module.exports = GoogleFontsWebpackPlugin
