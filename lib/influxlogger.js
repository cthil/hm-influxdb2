const Influxdb = require('influxdb-v2')
const HMInterface = require('hm-interface')
const Url = require('url')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const os = require('os')


module.exports = class InfluxLogger extends EventEmitter {
  constructor(configPath) {
    super()
    this.connected = false
    this.loggingBuffer = []
    this.logger = HMInterface.logger.logger('InfluxLogger')
    this.configPath = configPath
    this.reload()
  }

  loadWhitelist() {
    let self = this
    this.whitelist = []
    if (this.configuration.whitelist) {
      Object.keys(this.configuration.whitelist).forEach(key => {
        self.whitelist.push(self.configuration.whitelist[key])
      })
    }

    this.programlist = []
    if (this.configuration.programlist) {
      Object.keys(this.configuration.programlist).forEach(key => {
        self.programlist.push(self.configuration.programlist[key])
      })
    }

    this.variablelist = []
    if (this.configuration.variablelist) {
      Object.keys(this.configuration.variablelist).forEach(key => {
        self.variablelist.push(self.configuration.variablelist[key])
      })
    }
  }

  reload() {
    let cfgFile = path.join(this.configPath, 'config.json')
    if (fs.existsSync(cfgFile)) {
      this.logger.info('Config found')
      this.configuration = JSON.parse(fs.readFileSync(cfgFile))
    } else {
      this.configuration = {}
      this.configuration.ccuIP = '127.0.0.1'
      this.configuration.bufferSize = '1'
    }
    this.portRpl = { 'BidCos-RF': 2001, 'VirtualDevices': 9292, 'HmIP-RF': 2010 }
    // setup a local ccu
    this.init()
  }

  getConfig() {
    let cfgFile = path.join(this.configPath, 'config.json')
    if (fs.existsSync(cfgFile)) {
      return JSON.parse(fs.readFileSync(cfgFile))
    } else {
      return false
    }
  }

  saveConfig(cfg) {
    let cfgFile = path.join(this.configPath, 'config.json')
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, ' ', 2))
  }

  async init() {
    let self = this

    this.loggingHost = os.hostname()

    if (this.configuration) {
      this.loadWhitelist()

      if (this.whitelist) {
        if (this.interfaceClientManager) {
          this.logger.info('Removing old Intefaces')
          await this.interfaceClientManager.stop()
          this.logger.info('Done')
        }
        if (this.configuration.database) {
          this.connectDatabase(this.configuration.database)
        } else {
          this.logger.info('Missing Database Settings ...')
        }
        this.interfaceClientManager = new HMInterface.HomematicClientInterfaceManager({ clientName: 'cfl', timeout: 600, port: 9500 })
        this.interfaceClientManager.on('event', message => {
          let eventChannelName = '-'
          let channelRoom = '-'

          // check whitelist filter (applies to the whole address and reading name, e. g. HmIP-RF.12345678901234:1.HUMIDITY)
          let flt = self.whitelist.filter(entry => {
            var re = new RegExp(entry.value)
            return re.test(message.address)
          })

          let dpfl = []
          if ((flt.length === 0) && (self.configuration.datapoints)) {
            dpfl = self.configuration.datapoints.filter(entry => {
              return message.address === entry
            })
          }

          if ((flt.length > 0) || (dpfl.length > 0)) {
            let hmAddress = new HMInterface.HomeMaticAddress(message.address)
            let devs = self.regaClient.deviceByDatapointAddress(message.address)
            if (devs) {
              eventChannelName = devs.getChannelName(hmAddress.channelAddress())
              let channel = self.regaClient.channelByDatapointAddress(message.address)
              if ((channel) && (channel.room)) {
                channelRoom = channel.room.name
              }
            }

            if (message.value === true) {
              message.value = 1 // Convert boolean value of true to 1
            } else if (message.value === false) {
              message.value = 0 // Convert boolean value of false to 0
            }
            self.logger.info('Logging %s (%s) with value %s', message.address, eventChannelName, message.value)

            let point = {
              measurement: 'logging',
              tags: { source: self.loggingHost, address: message.address, type: message.datapoint, name: eventChannelName, room: channelRoom },
              fields: {
                value: message.value
              },
              timestamp: Date.now()
            }

            self.addToBuffer(point)
          }
        })

        if (this.configuration.ccuIP) {
          this.connectCCU()
        }
      } else {
        this.logger.warn('Config is missing so skip that for the moment')
      }
    } else {
      this.logger.warn('No whitelist found .. nothing to log')
    }
  }

  addToBuffer(point) {
    this.logger.debug('Adding %s to buffer', JSON.stringify(point))
    this.loggingBuffer.push(point)
    let bufferSize = this.configuration.bufferSize || 1
    if (this.loggingBuffer.length >= bufferSize) {
      this.logger.debug('Saving buffer (buffer fill %s level reached save threshold %s)', this.loggingBuffer.length, bufferSize)
      this.saveBuffer()
    } else {
      this.logger.info('Skipping buffer write (buffer fill %s level below save threshold %s)', this.loggingBuffer.length, bufferSize)
    }
  }

  saveBuffer() {
    if ((this.influxdb) && (this.connected)) {
      try {
        this.logger.debug('Saving buffer %s to database', JSON.stringify(this.loggingBuffer))
        this.influxdb.write({org: this.configuration.database.org, bucket: this.configuration.database.bucket, precision: 'ms'}, this.loggingBuffer)
        this.loggingBuffer = []
      } catch (e) {
        this.logger.error(e)
      }
    } else {
      this.logger.error('Unable to save buffer. Database not set or connected')
    }
  }

  async connectCCU() {
    let self = this
    // ask rega about the interfaces and connect
    this.logger.info(`Query Interfaces from ${this.configuration.ccuIP}`)
    this.regaClient = new HMInterface.HomeMaticRegaManager({ ccuIP: this.configuration.ccuIP})
    // load Interfaces
    this.regaClient.fetchInterfaces().then(interfaceList => {
      interfaceList.forEach(oInterface => {
        if ((oInterface.url !== undefined) && (oInterface.url.length > 1)) {
          // rebuild the urls for parsing
          let url = oInterface.url
          url = url.replace('xmlrpc_bin://', 'http://')
          url = url.replace('xmlrpc://', 'http://')
          let oUrl = Url.parse(url)
          let port = self.portRpl[oInterface.name]
          if (port === undefined) {
            port = oUrl.port
          }
          let host = (oUrl.hostname === '127.0.0.1') ? self.configuration.ccuIP : oUrl.hostname
          self.logger.info(`Adding interface ${oInterface.name} on Host ${host} Port ${port}`)
          self.interfaceClientManager.addInterface(oInterface.name, host, port, oUrl.pathname)
        }
      })
      // attach to interfaces
      self.interfaceClientManager.init()
      self.interfaceClientManager.connect()
    }).catch(error => {
      this.log.error(error)
    })
    this.logger.info(`Query DeviceList  ${this.configuration.ccuIP}`)
    this.regaClient.fetchDevices().then(deviceList => {
      self.deviceList = deviceList
    })
    this.logger.info('Devicelist done')
    await this.regaClient.fetchRooms().then
    this.logger.info('Roomlist done')

    this.emit('ccuconnected', this)
    setInterval(() => {
      self.updatePrograms()
      self.updateVariables()
    }, 60000)
    this.updatePrograms()
    this.updateVariables()
  }

  fetchPrograms() {
    let self = this
    return new Promise((resolve, reject) => {
      self.regaClient.fetchPrograms().then(progList => {
        resolve(progList)
      })
    })
  }

  clearCache() {
    this.deviceList = undefined
  }

  fetchDevices(includeDPs) {
    let self = this
    return new Promise((resolve, reject) => {
      if (self.deviceList === undefined) {
        self.regaClient.fetchDevices(includeDPs).then(deviceList => {
          self.deviceList = deviceList
          resolve(self.deviceList)
        })
      } else {
        resolve(self.deviceList)
      }
    })
  }

  processFilterList(deviceList) {
    let self = this
    let dpList = this.configuration.datapoints || []
    deviceList.forEach(device => {
      device.wl = undefined
      device.inWhitelist = undefined
      device.channels.forEach(channel => {
        channel.datapoints.forEach(datapoint => {
          let flt = self.whitelist.filter(entry => {
            return (datapoint.name.indexOf(entry.value) > -1)
          })

          if (dpList.indexOf(datapoint.name) > -1) {
            datapoint.selected = true
          }

          if (flt.length > 0) {
            device.inWhitelist = true
            if (!device.wl) {
              device.wl = []
            }
            device.wl.push(datapoint.name)
          }
        })
      })
    })
    return deviceList
  }

  setSelectedDatapoints(dpsList) {
    // run thru the list and check if DPS are here
    let listToSave = []
    if (dpsList) {
      dpsList.forEach(dp => {
        listToSave.push(dp)
      })
      let cfg = this.getConfig()
      if (cfg) {
        cfg.datapoints = listToSave
        this.saveConfig(cfg)
      }
    }
  }

  saveWhitelist(whiteList) {
    let cfg = this.getConfig()
    if (cfg === false) {
      cfg = {}
    }

    cfg.whitelist = whiteList
    this.saveConfig(cfg)
  }

  async updateVariables() {
    let self = this
    let varList = await this.regaClient.fetchVariablesbyIDs(self.variablelist || [])
    varList.forEach(variable => {
      if (variable.wasChanged) {
        self.addToBuffer({ measurement: 'logging', tags: { address: variable.id, type: 'VARIABLE', name: variable.name, room: '-' }, fields: { value: variable.state }, timestamp: variable.lastUpdate })
      }
    })
  }

  async updatePrograms() {
    let self = this
    let prgList = await this.regaClient.fetchProgrambyIDs(self.programlist || [])
    prgList.forEach(prg => {
      if (prg.lastRunChanged) {
        this.logger.info('adding %s', prg.name)
        let lrUtc = prg.lastRun * 1000
        self.addToBuffer({ measurement: 'logging', tags: { address: prg.id, type: 'PROGRAM', name: prg.name, room: '-' }, fields: { value: 1 }, timestamp: new Date(lrUtc) })
        // switch back 1 second later
        self.addToBuffer({ measurement: 'logging', tags: { address: prg.id, type: 'PROGRAM', name: prg.name, room: '-' }, fields: { value: 0 }, timestamp: new Date(lrUtc + 5000) })
      }
    })
  }

  stop() {
    let self = this
    return new Promise(async (resolve, reject) => {
      if (self.interfaceClientManager) {
        try {
          await self.interfaceClientManager.stop()
        } catch (e) {
          self.logger.error(e)
        }
      }
      self.saveBuffer()
      resolve()
    })
  }

  establishDatabaseConntection(options, dryrun) {
    this.logger.info('Trying to establish database connection')
    let self = this
    return new Promise((resolve, reject) => {
      let influxdb = new Influxdb(options)

      if (dryrun === true) {
        influxdb.query({org: options.org, csv: false }, {query: 'from(bucket: "'+options.bucket+'") |> range(start: -1m)'}).then( (value) => {
          self.logger.info('Dryrun test ok, database connection initialized')
          resolve({ message: 'ok' })
        }).catch((e) => {
          self.logger.error('Dryrun test failed')
          self.logger.error(e)
          reject(e)
        })
      } else {
        self.influxdb = influxdb
        self.connected = true
        self.logger.info('Database connection initialized')
        resolve({ message: 'ok' })
      }
    })
  }

  testConnection(options) {
    return this.establishDatabaseConntection(options, true)
  }

  connectDatabase(options) {
    let self = this
    this.establishDatabaseConntection(options, false).then().catch(e => {
      if ((e) && (e.code === 501)) {
        setTimeout(() => {
          // try again
          self.connectDatabase(options)
        }, 30000)
      }
    })
  }
}
