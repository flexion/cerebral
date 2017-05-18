import DependencyTracker from '../DependencyTracker'
import {Compute} from '../Compute'
import {getChangedProps, throwError, ensureStrictPath, createResolver} from './../utils'

class View {
  constructor ({
    dependencies,
    mergeProps,
    props,
    controller,
    displayName,
    onUpdate
  }) {
    this.stateGetter = this.stateGetter.bind(this)
    this.signalGetter = this.signalGetter.bind(this)
    this.mergeProps = mergeProps
    this.controller = controller
    this._displayName = displayName
    this._hasWarnedBigComponent = false
    this.onUpdate = onUpdate
    /*
      First we find any dependency functions to convert to DependencyTrackers.
      They are instantly run to produce their value and map of state
      dependencies
    */
    this.dependencyTrackers = Object.keys(dependencies).reduce((currentDependencyTrackers, dependencyKey) => {
      if (dependencies[dependencyKey] instanceof Compute) {
        currentDependencyTrackers[dependencyKey] = new DependencyTracker(dependencies[dependencyKey])
        currentDependencyTrackers[dependencyKey].run(this.stateGetter, props)
      }

      return currentDependencyTrackers
    }, {})
    this.dependencies = dependencies
    this.dependencyTrackersDependencyMaps = this.getDependencyTrackersDependencyMaps(props)
    this.tagsDependencyMap = this.getTagsDependencyMap(props)
  }
  /*
    A getter for StateTracker and tags to grab state from Cerebral
  */
  stateGetter (path) {
    return this.controller.getState(path)
  }
  /*
    A getter for tags to grab signals from Cerebral
  */
  signalGetter (path) {
    return this.controller.getSignal(path)
  }
  onMount () {
    const depsMap = Object.assign(
      {},
      this.dependencyTrackersDependencyMaps.state,
      this.tagsDependencyMap
    )

    this.controller.componentDependencyStore.addEntity(this, depsMap)

    if (this.controller.devtools) {
      this.controller.devtools.updateComponentsMap(this, depsMap)
    }
  }
  onUnMount () {
    this.controller.componentDependencyStore.removeEntity(this, Object.assign(
      {},
      this.dependencyTrackersDependencyMaps.state,
      this.tagsDependencyMap
    ))
  }
  onPropsUpdate (props, nextProps) {
    const propsChanges = getChangedProps(props, nextProps)
    if (propsChanges.length) {
      this.updateFromProps(propsChanges, nextProps)

      return true
    }

    return false
  }
  /*
    Called by component when props are passed from parent and they
    have changed. In this situation both tags and depndency trackers might
    be affected. Tags are just updated and dependency trackers are matched
    on props changed
  */
  updateFromProps (propsChanges, props) {
    this.update(props, this.updateDependencyTrackers({}, propsChanges, props))
  }
  /*
    Called by Container when the components state dependencies
    has changed. In this scenario we need to run any dependencyTrackers
    that matches the state changes. There is no need to update the tags
    as their declared state deps can not change
  */
  updateFromState (stateChanges, props, force) {
    this.update(props, force ? this.forceUpdateDependencyTrackers() : this.updateDependencyTrackers(stateChanges, {}, props))
  }
  /*
    Udpates the dependency trackers by checking state
    changes and props changes
  */
  updateDependencyTrackers (stateChanges, propsChanges, props) {
    const hasChanged = Object.keys(this.dependencyTrackers).reduce((hasChanged, key) => {
      if (this.dependencyTrackers[key].match(stateChanges, propsChanges)) {
        this.dependencyTrackers[key].run(this.stateGetter, props)

        return true
      }

      return hasChanged
    }, false)

    return hasChanged
  }
  /*
    Run update, re-evaluating the tags and computed, if neccessary
  */
  update (props, hasChangedDependencyTrackers) {
    const prevDependencyTrackersDependencyMaps = this.dependencyTrackersDependencyMaps
    const previousTagsDependencyMap = this.tagsDependencyMap

    this.tagsDependencyMap = this.getTagsDependencyMap(props)
    this.dependencyTrackersDependencyMaps = hasChangedDependencyTrackers ? this.getDependencyTrackersDependencyMaps(props) : this.dependencyTrackersDependencyMaps

    const prevDepsMap = Object.assign(
      {},
      prevDependencyTrackersDependencyMaps.state,
      previousTagsDependencyMap
    )
    const nextDepsMap = Object.assign(
      {},
      this.dependencyTrackersDependencyMaps.state,
      this.tagsDependencyMap
    )
    this.controller.componentDependencyStore.updateEntity(this, prevDepsMap, nextDepsMap)
  }
  /*
    Forces update of all computed
  */
  forceUpdateDependencyTrackers () {
    Object.keys(this.dependencyTrackers).forEach((key) => {
      this.dependencyTrackers[key].run(this.stateGetter, this.props)
    })

    return true
  }
  /*
    Go through dependencies and identify state trackers and
    merge in their state dependencies
  */
  getDependencyTrackersDependencyMaps (props) {
    return Object.keys(this.dependencies).reduce((currentDepsMaps, propKey) => {
      if (this.dependencyTrackers[propKey]) {
        currentDepsMaps.state = Object.assign(currentDepsMaps.state, this.dependencyTrackers[propKey].stateTrackFlatMap)
        currentDepsMaps.props = Object.assign(currentDepsMaps.props, this.dependencyTrackers[propKey].propsTrackFlatMap)

        return currentDepsMaps
      }

      return currentDepsMaps
    }, {
      state: {},
      props: {}
    })
  }
  /*
    Go through dependencies and extract tags related to state
    dependencies
  */
  getTagsDependencyMap (props) {
    return Object.keys(this.dependencies).reduce((currentDepsMap, propKey) => {
      if (this.dependencyTrackers[propKey]) {
        return currentDepsMap
      }

      if (!this.dependencies[propKey].getTags) {
        throwError(`Prop ${propKey} should be tags or a function on the specific property you want to dynamically create.`)
      }

      const getters = this.createTagGetters(props)

      return this.dependencies[propKey].getTags(getters).reduce((updatedCurrentDepsMap, tag) => {
        if (tag.options.isStateDependency) {
          const path = tag.getPath(getters)
          const strictPath = ensureStrictPath(path, this.stateGetter(path))

          updatedCurrentDepsMap[strictPath] = true
        }

        return updatedCurrentDepsMap
      }, currentDepsMap)
    }, {})
  }
  /*
    Creates getters passed into tags
  */
  createTagGetters (props) {
    return {
      state: this.stateGetter,
      props: props,
      signal: this.signalGetter
    }
  }
  /*
    Runs whenever the component has an update and renders.
    Extracts the actual values from dependency trackers and/or tags
  */
  getProps (props = {}) {
    const dependenciesProps = Object.keys(this.dependencies).reduce((currentProps, key) => {
      if (!this.dependencies[key]) {
        throwError(`There is no dependency assigned to prop ${key}`)
      }

      if (this.dependencyTrackers[key]) {
        currentProps[key] = this.dependencyTrackers[key].value
      } else {
        const tag = this.dependencies[key]
        const getters = this.createTagGetters(props)

        if (tag.type === 'state') {
          const path = tag.getPath(getters)
          const value = this.stateGetter(path)

          if (path.indexOf('.*') > 0) {
            currentProps[key] = value ? Object.keys(value) : []
          } else {
            currentProps[key] = value
          }
        } else if (tag.type === 'signal') {
          try {
            currentProps[key] = tag.getValue(getters)
          } catch (e) {
            const path = tag.getPath(getters)
            throwError(`Component ${this._displayName} There is no signal at '${path}'`)
          }
        } else if (tag.type === 'props') {
          currentProps[key] = tag.getValue(getters)
        }
      }

      return currentProps
    }, {})

    if (
      this.controller.devtools &&
      this.controller.devtools.bigComponentsWarning &&
      !this._hasWarnedBigComponent &&
      Object.keys(this.dependencies).length >= this.controller.devtools.bigComponentsWarning
    ) {
      console.warn(`Component named ${this._displayName} has a lot of dependencies, consider refactoring or adjust this option in devtools`)
      this._hasWarnedBigComponent = true
    }

    if (this.mergeProps) {
      return this.mergeProps(dependenciesProps, props, createResolver(this.createTagGetters(props)))
    }

    return Object.assign({}, props, dependenciesProps)
  }
}

export default View