source 'https://rubygems.org'

# You may use http://rbenv.org/ or https://rvm.io/ to install and use this version
ruby ">= 2.6.10"

# Exclude problematic versions of cocoapods and activesupport that causes build failures.
gem 'cocoapods', '>= 1.13', '!= 1.15.0', '!= 1.15.1'
# The activesupport and concurrent-ruby floors are the releases that fix their published advisories;
# Homebrew's CocoaPods 1.17 runs on the same two. activesupport 7.2 requires logger itself, which
# the old concurrent-ruby ceiling stood in for.
gem 'activesupport', '>= 7.2.3.1'
gem 'xcodeproj', '< 1.26.0'
gem 'concurrent-ruby', '>= 1.3.7'

# Ruby 3.4.0 has removed some libraries from the standard library.
gem 'bigdecimal'
gem 'logger'
gem 'benchmark'
gem 'mutex_m'
gem 'nkf'
