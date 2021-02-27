mkdir -p tmp
rm -rf tmp/*
mkdir -p tmp/js
mkdir -p tmp/www

# copy all relevant stuff
cp -a update_script tmp/
cp -a rc.d tmp/
cp -a VERSION tmp/www
cp -a etc/www tmp/
cp -a ../package.json tmp/js
cp -a ../index.js tmp/js
cp -af ../lib tmp/js      

# generate archive
cd tmp
tar --exclude=._* --exclude=.DS_Store -czvf ../hm-influxdb-$(cat ../VERSION).tar.gz *
cd ..
rm -rf tmp
