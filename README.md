## hm-influxdb2
is an addon for your ccu3 or rasberrymatic to automatic log datapoints into an influx2 database.
It is based on hm-influxdb from https://github.com/thkl/hm-influxdb

### Installation
Download the addon and install it via system preferences on to your ccu

### Configuration

Open the settings page via plugin settings or http://ccuip:9501/ (please make sure the firewall at your ccu will not block this port).
Attention: The settings interface is currently exposed *without* authentification! To provide basic security, block access to this port after setting the parameters.

First setup the Influx DB 2 database:
* click on the database menu item (it not opened by default)
* enter the host or ip of your database
* enter the port of your database
* select the protocol to access your database (http or https)
* enter the bucket name (must be existing)
* enter the organization name
* enter a token, which has read (for connection checking) and write permissions to the database
* Press the test button to check your connection
* if the addon is able to talk to our influx server you can save the connection data by clicking the save button

Setup the log source:
* click on the ccu menu item
* enter the host or ip of the CCU (Attention: No authentification is made. So either run locally on the CCU, or disable authentification)
* enther the buffer size (data points to collect before writing to the database)
* the configure the data point filter:

Here you have two options to select which data the addon is logging:

#### 1. Whitelist
With whitelist settings you are able to log all datapoints of one type. As an example: You want to log all temperatures, so add an entry with \.ACTUAL_TEMPERATURE$.
In this case, every message form your devices which contains the datapoint with .ACTUAL_TEMPERATURE will be logged.
You can also specify a more complex filter: As in contrast to hm-influxdb, the string is taken as a regular expression. Take care to quote special characters, e. g. the dot in the example above.

#### 2. Device specific
You can select specific datapoints from your devices. Please use the tree view to choose which datapoints you want to log

Please note: If an datapoint will be logged thru a whitelist entry u can't dissable the logging by the device view for this entry.

Please do not forget to save your settings.


### Internals
A buffer size of > 1 prevents excessive accesses to the database. The timestamp is taken from the event itself (not DB write), so don't worry.
A larger buffer size may result in data loss if the program/CCU/... crashes before saving, so be careful.

The addon will add device or channel names into a entry so you are able to identify your time series by the device name.